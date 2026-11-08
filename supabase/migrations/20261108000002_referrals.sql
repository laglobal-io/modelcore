-- ModelCore referral system
--
-- Flow
--   1. Visitor hits /r/{code}            -> referral_clicks row + first-touch cookie
--   2. Visitor completes onboarding       -> magic link carries ref metadata
--   3. auth.users insert                  -> handle_new_user() creates profile + referral_attributions row
--      (colleagues from the same company domain inherit the attribution)
--   4. Deal moves to 'released'           -> trigger creates referral_commissions (one per referred side)
--      Deal moves to 'refunded'/'cancelled' -> unpaid commissions are voided
--   5. Payout cron                        -> claim_partner_payout() batches approved commissions,
--                                            Stripe transfer, then mark_payout_paid()/mark_payout_failed()

-- ---------------------------------------------------------------------------
-- Settings (tunable without a deploy)
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('platform_fee_bps',          '1000'),   -- 10% success fee
  ('partner_share_bps',         '2500'),   -- partner earns 25% of the platform fee
  ('attribution_window_months', '24'),
  ('min_payout_cents',          '5000'),   -- $50 minimum transfer
  ('one_commission_per_partner_per_deal', 'true');

create or replace function public.setting_int(p_key text) returns integer
language sql stable security definer set search_path = public as $$
  select (value #>> '{}')::integer from public.app_settings where key = p_key;
$$;

create or replace function public.setting_bool(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::boolean from public.app_settings where key = p_key), false);
$$;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.partner_type as enum ('sell_side', 'buy_side', 'talent', 'general');
create type public.partner_status as enum ('pending', 'active', 'suspended');
create type public.attribution_source as enum ('link', 'code', 'domain', 'manual');
create type public.commission_side as enum ('seller', 'buyer');
create type public.commission_status as enum ('pending', 'approved', 'paid', 'void');
create type public.payout_status as enum ('processing', 'paid', 'failed');

-- ---------------------------------------------------------------------------
-- Partners
-- ---------------------------------------------------------------------------
create table public.partners (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null unique references public.profiles (id) on delete cascade,
  code              citext not null unique check (code ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  type              public.partner_type not null default 'general',
  status            public.partner_status not null default 'active',
  share_bps         integer check (share_bps between 0 and 10000),  -- null = use default setting
  stripe_account_id text unique,
  payouts_enabled   boolean not null default false,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Clicks (raw tracking; partners only ever see aggregates)
-- ---------------------------------------------------------------------------
create table public.referral_clicks (
  id            bigint generated always as identity primary key,
  partner_id    uuid not null references public.partners (id) on delete cascade,
  visitor_id    uuid not null,
  landing_path  text,
  referrer      text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  country       text,
  ip_hash       text,      -- salted SHA-256, never the raw IP
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index referral_clicks_partner_idx on public.referral_clicks (partner_id, created_at desc);
create index referral_clicks_visitor_idx on public.referral_clicks (visitor_id);

-- ---------------------------------------------------------------------------
-- Attributions: one partner per referred profile, for a fixed window
-- ---------------------------------------------------------------------------
create table public.referral_attributions (
  id              uuid primary key default gen_random_uuid(),
  partner_id      uuid not null references public.partners (id) on delete cascade,
  profile_id      uuid not null unique references public.profiles (id) on delete cascade,
  company_domain  citext,
  source          public.attribution_source not null,
  click_id        bigint references public.referral_clicks (id) on delete set null,
  inherited_from  uuid references public.referral_attributions (id) on delete set null,
  first_touch_at  timestamptz not null,
  attributed_at   timestamptz not null default now(),
  expires_at      timestamptz not null,
  created_by      uuid references public.profiles (id),   -- admin for manual attributions
  note            text
);
create index referral_attributions_partner_idx on public.referral_attributions (partner_id);
create index referral_attributions_domain_idx on public.referral_attributions (company_domain, expires_at);

-- ---------------------------------------------------------------------------
-- Commissions and payouts
-- ---------------------------------------------------------------------------
create table public.partner_payouts (
  id                  uuid primary key default gen_random_uuid(),
  partner_id          uuid not null references public.partners (id),
  amount_cents        bigint not null check (amount_cents > 0),
  currency            text not null default 'usd',
  status              public.payout_status not null default 'processing',
  stripe_transfer_id  text unique,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);
create index partner_payouts_partner_idx on public.partner_payouts (partner_id, created_at desc);
-- At most one in-flight payout per partner.
create unique index partner_payouts_one_processing on public.partner_payouts (partner_id) where status = 'processing';

create table public.referral_commissions (
  id                  uuid primary key default gen_random_uuid(),
  partner_id          uuid not null references public.partners (id),
  deal_id             uuid not null references public.deals (id) on delete cascade,
  attribution_id      uuid not null references public.referral_attributions (id),
  side                public.commission_side not null,
  deal_amount_cents   bigint not null,
  platform_fee_cents  bigint not null,
  share_bps           integer not null,
  commission_cents    bigint not null check (commission_cents >= 0),
  currency            text not null default 'usd',
  status              public.commission_status not null default 'pending',
  payout_id           uuid references public.partner_payouts (id) on delete set null,
  void_reason         text,
  created_at          timestamptz not null default now(),
  approved_at         timestamptz,
  paid_at             timestamptz,
  unique (deal_id, side)
);
create index referral_commissions_partner_idx on public.referral_commissions (partner_id, status);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.email_domain(p_email text) returns citext
language sql immutable as $$
  select nullif(lower(split_part(p_email, '@', 2)), '')::citext;
$$;

create or replace function public.is_free_email_domain(p_domain text) returns boolean
language sql immutable as $$
  select lower(coalesce(p_domain, '')) = any (array[
    '', 'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com',
    'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
    'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'hey.com', 'fastmail.com'
  ]);
$$;

-- Fee math kept in one place. Fee rounds half-up; partner commission rounds down.
create or replace function public.platform_fee_cents(p_amount bigint, p_fee_bps integer) returns bigint
language sql immutable as $$
  select round(p_amount::numeric * p_fee_bps / 10000)::bigint;
$$;

create or replace function public.commission_cents(p_fee bigint, p_share_bps integer) returns bigint
language sql immutable as $$
  select floor(p_fee::numeric * p_share_bps / 10000)::bigint;
$$;

-- ---------------------------------------------------------------------------
-- Attribution at signup
-- ---------------------------------------------------------------------------
create or replace function public.attribute_profile(
  p_profile_id     uuid,
  p_code           text,
  p_click_id       bigint default null,
  p_first_touch_at timestamptz default null
) returns public.referral_attributions
language plpgsql security definer set search_path = public as $$
declare
  v_profile   public.profiles;
  v_partner   public.partners;
  v_partner_domain citext;
  v_click     public.referral_clicks;
  v_existing  public.referral_attributions;
  v_inherit   public.referral_attributions;
  v_first     timestamptz;
  v_window    integer := coalesce(public.setting_int('attribution_window_months'), 24);
  v_row       public.referral_attributions;
begin
  select * into v_profile from public.profiles where id = p_profile_id;
  if not found then return null; end if;

  -- First attribution wins; never re-attribute.
  select * into v_existing from public.referral_attributions where profile_id = p_profile_id;
  if found then return v_existing; end if;

  if nullif(trim(coalesce(p_code, '')), '') is not null then
    select * into v_partner from public.partners
      where code = lower(trim(p_code))::citext and status = 'active';

    if found and v_partner.profile_id <> p_profile_id then
      -- No credit for referring your own company.
      select company_domain into v_partner_domain from public.profiles where id = v_partner.profile_id;
      if v_profile.company_domain is not null and v_partner_domain is not null
         and v_profile.company_domain = v_partner_domain then
        return null;
      end if;

      -- Only trust a click id that belongs to this partner.
      if p_click_id is not null then
        select * into v_click from public.referral_clicks where id = p_click_id and partner_id = v_partner.id;
      end if;

      v_first := least(now(), coalesce(v_click.created_at, p_first_touch_at, now()));

      insert into public.referral_attributions
        (partner_id, profile_id, company_domain, source, click_id, first_touch_at, expires_at)
      values
        (v_partner.id, p_profile_id, v_profile.company_domain,
         case when v_click.id is not null then 'link' else 'code' end::public.attribution_source,
         v_click.id, v_first, v_first + make_interval(months => v_window))
      returning * into v_row;
      return v_row;
    end if;
  end if;

  -- No usable code: a colleague at an already-referred company inherits that attribution.
  if v_profile.company_domain is not null and not public.is_free_email_domain(v_profile.company_domain) then
    select a.* into v_inherit
      from public.referral_attributions a
      join public.partners p on p.id = a.partner_id and p.status = 'active'
     where a.company_domain = v_profile.company_domain
       and a.expires_at > now()
       and p.profile_id <> p_profile_id
     order by a.first_touch_at asc
     limit 1;

    if found then
      insert into public.referral_attributions
        (partner_id, profile_id, company_domain, source, inherited_from, first_touch_at, expires_at)
      values
        (v_inherit.partner_id, p_profile_id, v_profile.company_domain, 'domain',
         v_inherit.id, v_inherit.first_touch_at, v_inherit.expires_at)
      returning * into v_row;
      return v_row;
    end if;
  end if;

  return null;
end $$;

-- Profile creation from signup metadata (set server-side by /api/onboarding).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_role   public.user_role;
  v_domain citext := public.email_domain(new.email);
  v_click  bigint;
  v_touch  timestamptz;
begin
  begin
    v_role := coalesce(nullif(m->>'role', ''), 'seller')::public.user_role;
  exception when invalid_text_representation then
    v_role := 'seller';
  end;

  insert into public.profiles (id, role, full_name, email, company, company_domain, website, phone, intake)
  values (
    new.id, v_role,
    coalesce(m->>'full_name', ''),
    new.email,
    nullif(m->>'company', ''),
    case when public.is_free_email_domain(v_domain) then null else v_domain end,
    nullif(m->>'website', ''),
    nullif(m->>'phone', ''),
    coalesce(m->'intake', '{}'::jsonb)
  );

  begin v_click := (m->>'ref_click_id')::bigint; exception when others then v_click := null; end;
  begin v_touch := (m->>'ref_first_touch_at')::timestamptz; exception when others then v_touch := null; end;

  perform public.attribute_profile(new.id, m->>'ref_code', v_click, v_touch);
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Commissions at deal release
-- ---------------------------------------------------------------------------
create or replace function public.create_deal_commissions(p_deal_id uuid)
returns setof public.referral_commissions
language plpgsql security definer set search_path = public as $$
declare
  v_deal      public.deals;
  v_at        timestamptz;
  v_fee       bigint;
  v_default   integer := coalesce(public.setting_int('partner_share_bps'), 2500);
  v_once      boolean := public.setting_bool('one_commission_per_partner_per_deal');
  v_seller_partner uuid;
  r           record;
begin
  select * into v_deal from public.deals where id = p_deal_id;
  if not found or v_deal.status <> 'released' then return; end if;

  v_at  := coalesce(v_deal.released_at, now());
  v_fee := public.platform_fee_cents(v_deal.amount_cents, v_deal.platform_fee_bps);

  for r in
    select 'seller'::public.commission_side as side, a.id as attribution_id, p.id as partner_id,
           coalesce(p.share_bps, v_default) as share_bps
      from public.referral_attributions a
      join public.partners p on p.id = a.partner_id and p.status = 'active'
     where a.profile_id = v_deal.seller_id and a.expires_at >= v_at
    union all
    select 'buyer'::public.commission_side, a.id, p.id, coalesce(p.share_bps, v_default)
      from public.referral_attributions a
      join public.partners p on p.id = a.partner_id and p.status = 'active'
     where a.profile_id = v_deal.buyer_id and a.expires_at >= v_at
     order by 1  -- seller side first
  loop
    -- A partner who referred both sides is paid once per deal (configurable).
    if r.side = 'seller' then
      v_seller_partner := r.partner_id;
    elsif v_once and r.partner_id = v_seller_partner then
      continue;
    end if;

    return query
      insert into public.referral_commissions
        (partner_id, deal_id, attribution_id, side, deal_amount_cents, platform_fee_cents,
         share_bps, commission_cents, currency, status, approved_at)
      values
        (r.partner_id, v_deal.id, r.attribution_id, r.side, v_deal.amount_cents, v_fee,
         r.share_bps, public.commission_cents(v_fee, r.share_bps), v_deal.currency, 'approved', now())
      on conflict (deal_id, side) do nothing
      returning *;
  end loop;
end $$;

create or replace function public.deals_referral_hook() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'released' and old.status is distinct from 'released' then
    if new.released_at is null then
      update public.deals set released_at = now() where id = new.id and released_at is null;
    end if;
    perform public.create_deal_commissions(new.id);
  elsif new.status in ('refunded', 'cancelled') and old.status is distinct from new.status then
    update public.referral_commissions
       set status = 'void', void_reason = 'deal ' || new.status::text
     where deal_id = new.id and status in ('pending', 'approved') and payout_id is null;
  end if;
  return new;
end $$;

create trigger deals_referral_after_update
  after update of status on public.deals
  for each row execute function public.deals_referral_hook();

-- ---------------------------------------------------------------------------
-- Payout batching (called by the cron route with the service role)
-- ---------------------------------------------------------------------------
create or replace function public.claim_partner_payout(p_partner_id uuid)
returns public.partner_payouts
language plpgsql security definer set search_path = public as $$
declare
  v_partner public.partners;
  v_total   bigint;
  v_min     integer := coalesce(public.setting_int('min_payout_cents'), 5000);
  v_payout  public.partner_payouts;
begin
  select * into v_partner from public.partners where id = p_partner_id for update;
  if not found or v_partner.status <> 'active' or not v_partner.payouts_enabled then return null; end if;
  if exists (select 1 from public.partner_payouts where partner_id = p_partner_id and status = 'processing') then
    return null;
  end if;

  select coalesce(sum(commission_cents), 0) into v_total
    from public.referral_commissions
   where partner_id = p_partner_id and status = 'approved' and payout_id is null;
  if v_total < v_min then return null; end if;

  insert into public.partner_payouts (partner_id, amount_cents) values (p_partner_id, v_total)
  returning * into v_payout;

  update public.referral_commissions set payout_id = v_payout.id
   where partner_id = p_partner_id and status = 'approved' and payout_id is null;

  return v_payout;
end $$;

create or replace function public.mark_payout_paid(p_payout_id uuid, p_transfer_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.partner_payouts
     set status = 'paid', stripe_transfer_id = p_transfer_id, paid_at = now()
   where id = p_payout_id and status = 'processing';
  update public.referral_commissions
     set status = 'paid', paid_at = now()
   where payout_id = p_payout_id and status = 'approved';
end $$;

create or replace function public.mark_payout_failed(p_payout_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.partner_payouts
     set status = 'failed', failure_reason = left(p_reason, 500)
   where id = p_payout_id and status = 'processing';
  update public.referral_commissions set payout_id = null
   where payout_id = p_payout_id and status = 'approved';
end $$;

-- ---------------------------------------------------------------------------
-- Partner self-service
-- ---------------------------------------------------------------------------
create or replace function public.become_partner(p_code text, p_type public.partner_type default 'general')
returns public.partners
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.partners;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into v_row from public.partners where profile_id = v_uid;
  if found then return v_row; end if;
  if lower(trim(p_code)) !~ '^[a-z0-9][a-z0-9-]{2,31}$' then
    raise exception 'Codes are 3-32 characters: letters, numbers and hyphens' using errcode = '22023';
  end if;
  if lower(trim(p_code)) = any (array['admin','modelcore','api','www','support','help','partners','r']) then
    raise exception 'That code is reserved' using errcode = '22023';
  end if;
  insert into public.partners (profile_id, code, type)
  values (v_uid, lower(trim(p_code)), p_type)
  returning * into v_row;
  return v_row;
exception when unique_violation then
  raise exception 'That code is taken' using errcode = '23505';
end $$;

-- ---------------------------------------------------------------------------
-- Dashboards (read models). Security definer, scoped to the caller.
-- ---------------------------------------------------------------------------
create or replace function public.partner_pipeline_for(p_partner_id uuid)
returns table (
  attribution_id   uuid,
  company          text,
  role             public.user_role,
  source           public.attribution_source,
  attributed_at    timestamptz,
  expires_at       timestamptz,
  stage            text,
  listings_count   bigint,
  deals_closed     bigint,
  gross_cents      bigint,
  commission_cents bigint
)
language sql stable security definer set search_path = public as $$
  select
    a.id,
    coalesce(pr.company, pr.company_domain::text, 'Unnamed company'),
    pr.role,
    a.source,
    a.attributed_at,
    a.expires_at,
    case
      when d.closed > 0 then 'deal_closed'
      when exists (select 1 from public.deals x where (x.seller_id = pr.id or x.buyer_id = pr.id)
                    and x.status in ('accepted','escrow_funded','delivered')) then 'in_escrow'
      when exists (select 1 from public.nda_agreements n where (n.seller_id = pr.id or n.buyer_id = pr.id)
                    and n.buyer_signed_at is not null and n.seller_signed_at is not null) then 'nda_signed'
      when l.cnt > 0 or exists (select 1 from public.data_requests q where q.buyer_id = pr.id) then 'active'
      else 'signed_up'
    end,
    coalesce(l.cnt, 0),
    coalesce(d.closed, 0),
    coalesce(d.gross, 0),
    coalesce(c.total, 0)
  from public.referral_attributions a
  join public.profiles pr on pr.id = a.profile_id
  left join lateral (select count(*) cnt from public.listings li where li.seller_id = pr.id and li.status = 'published') l on true
  left join lateral (
    select count(*) closed, sum(x.amount_cents)::bigint gross
      from public.deals x
     where (x.seller_id = pr.id or x.buyer_id = pr.id) and x.status = 'released'
  ) d on true
  left join lateral (
    select sum(rc.commission_cents)::bigint total
      from public.referral_commissions rc
     where rc.attribution_id = a.id and rc.status <> 'void'
  ) c on true
  where a.partner_id = p_partner_id
  order by a.attributed_at desc;
$$;

create or replace function public.partner_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_partner public.partners;
  v_share   integer;
begin
  select * into v_partner from public.partners where profile_id = auth.uid();
  if not found then return null; end if;
  v_share := coalesce(v_partner.share_bps, public.setting_int('partner_share_bps'));

  return jsonb_build_object(
    'partner', jsonb_build_object(
      'id', v_partner.id, 'code', v_partner.code, 'type', v_partner.type, 'status', v_partner.status,
      'share_bps', v_share, 'platform_fee_bps', public.setting_int('platform_fee_bps'),
      'payouts_enabled', v_partner.payouts_enabled,
      'attribution_window_months', public.setting_int('attribution_window_months'),
      'min_payout_cents', public.setting_int('min_payout_cents')),
    'stats', jsonb_build_object(
      'clicks_30d',   (select count(*) from public.referral_clicks where partner_id = v_partner.id and created_at > now() - interval '30 days'),
      'clicks_total', (select count(*) from public.referral_clicks where partner_id = v_partner.id),
      'visitors_total', (select count(distinct visitor_id) from public.referral_clicks where partner_id = v_partner.id),
      'signups',      (select count(*) from public.referral_attributions where partner_id = v_partner.id),
      'active_referrals', (select count(*) from public.referral_attributions where partner_id = v_partner.id and expires_at > now()),
      'deals_closed', (select count(distinct deal_id) from public.referral_commissions where partner_id = v_partner.id and status <> 'void'),
      'pending_cents',  (select coalesce(sum(commission_cents),0) from public.referral_commissions where partner_id = v_partner.id and status = 'pending'),
      'approved_cents', (select coalesce(sum(commission_cents),0) from public.referral_commissions where partner_id = v_partner.id and status = 'approved'),
      'paid_cents',     (select coalesce(sum(commission_cents),0) from public.referral_commissions where partner_id = v_partner.id and status = 'paid')),
    'clicks_by_day', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'clicks', n) order by d)
        from (select date_trunc('day', created_at)::date as d, count(*) as n
                from public.referral_clicks
               where partner_id = v_partner.id and created_at > now() - interval '30 days'
               group by 1) t), '[]'::jsonb),
    'pipeline', coalesce((select jsonb_agg(to_jsonb(p)) from public.partner_pipeline_for(v_partner.id) p), '[]'::jsonb),
    'commissions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', rc.id, 'side', rc.side, 'status', rc.status, 'company', coalesce(pr.company, 'Unnamed company'),
               'deal_amount_cents', rc.deal_amount_cents, 'commission_cents', rc.commission_cents,
               'created_at', rc.created_at, 'paid_at', rc.paid_at) order by rc.created_at desc)
        from public.referral_commissions rc
        join public.referral_attributions a on a.id = rc.attribution_id
        join public.profiles pr on pr.id = a.profile_id
       where rc.partner_id = v_partner.id), '[]'::jsonb),
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'amount_cents', amount_cents, 'status', status,
               'created_at', created_at, 'paid_at', paid_at) order by created_at desc)
        from public.partner_payouts where partner_id = v_partner.id), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_referral_overview()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'totals', jsonb_build_object(
      'partners', (select count(*) from public.partners),
      'clicks_30d', (select count(*) from public.referral_clicks where created_at > now() - interval '30 days'),
      'attributions', (select count(*) from public.referral_attributions),
      'owed_cents', (select coalesce(sum(commission_cents),0) from public.referral_commissions where status = 'approved'),
      'paid_cents', (select coalesce(sum(commission_cents),0) from public.referral_commissions where status = 'paid')),
    'partners', coalesce((
      select jsonb_agg(row_to_json(t) order by t.earned_cents desc, t.signups desc) from (
        select p.id, p.code, p.type, p.status, p.payouts_enabled,
               coalesce(pr.full_name, '') as name, pr.email, pr.company,
               (select count(*) from public.referral_clicks c where c.partner_id = p.id) as clicks,
               (select count(*) from public.referral_attributions a where a.partner_id = p.id) as signups,
               (select count(distinct rc.deal_id) from public.referral_commissions rc where rc.partner_id = p.id and rc.status <> 'void') as deals,
               (select coalesce(sum(rc.commission_cents),0) from public.referral_commissions rc where rc.partner_id = p.id and rc.status in ('approved','paid')) as earned_cents,
               (select coalesce(sum(rc.commission_cents),0) from public.referral_commissions rc where rc.partner_id = p.id and rc.status = 'approved') as owed_cents
          from public.partners p join public.profiles pr on pr.id = p.profile_id) t), '[]'::jsonb),
    'recent_attributions', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select a.id, p.code as partner_code, coalesce(pr.company, pr.email::text) as company, pr.role,
               a.source, a.attributed_at, a.expires_at
          from public.referral_attributions a
          join public.partners p on p.id = a.partner_id
          join public.profiles pr on pr.id = a.profile_id
         order by a.attributed_at desc limit 50) t), '[]'::jsonb)
  );
end $$;

-- Admin tool: attribute an existing profile by hand (e.g. offline intro).
create or replace function public.admin_attribute(p_profile_id uuid, p_partner_code text, p_note text default null)
returns public.referral_attributions
language plpgsql security definer set search_path = public as $$
declare
  v_partner public.partners;
  v_profile public.profiles;
  v_window  integer := coalesce(public.setting_int('attribution_window_months'), 24);
  v_row     public.referral_attributions;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select * into v_partner from public.partners where code = lower(trim(p_partner_code))::citext;
  if not found then raise exception 'partner not found' using errcode = 'P0002'; end if;
  select * into v_profile from public.profiles where id = p_profile_id;
  if not found then raise exception 'profile not found' using errcode = 'P0002'; end if;
  if v_partner.profile_id = p_profile_id then raise exception 'self-referral' using errcode = '22023'; end if;

  insert into public.referral_attributions
    (partner_id, profile_id, company_domain, source, first_touch_at, expires_at, created_by, note)
  values
    (v_partner.id, p_profile_id, v_profile.company_domain, 'manual', now(),
     now() + make_interval(months => v_window), auth.uid(), p_note)
  returning * into v_row;
  return v_row;
exception when unique_violation then
  raise exception 'profile is already attributed' using errcode = '23505';
end $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.app_settings          enable row level security;
alter table public.partners              enable row level security;
alter table public.referral_clicks       enable row level security;
alter table public.referral_attributions enable row level security;
alter table public.referral_commissions  enable row level security;
alter table public.partner_payouts       enable row level security;

create policy settings_read on public.app_settings for select to authenticated using (true);
create policy settings_admin on public.app_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy partners_self on public.partners for select to authenticated
  using (profile_id = auth.uid() or public.is_admin());

-- Raw clicks hold IP hashes and user agents: admin only. Partners read aggregates via partner_dashboard().
create policy clicks_admin on public.referral_clicks for select to authenticated using (public.is_admin());

create policy attributions_partner on public.referral_attributions for select to authenticated
  using (public.is_admin() or partner_id in (select id from public.partners where profile_id = auth.uid()));

create policy commissions_partner on public.referral_commissions for select to authenticated
  using (public.is_admin() or partner_id in (select id from public.partners where profile_id = auth.uid()));

create policy payouts_partner on public.partner_payouts for select to authenticated
  using (public.is_admin() or partner_id in (select id from public.partners where profile_id = auth.uid()));

-- Lock down internal functions: only the service role and SQL owner may call them.
revoke execute on function public.attribute_profile(uuid, text, bigint, timestamptz) from public, anon, authenticated;
revoke execute on function public.create_deal_commissions(uuid) from public, anon, authenticated;
revoke execute on function public.claim_partner_payout(uuid) from public, anon, authenticated;
revoke execute on function public.mark_payout_paid(uuid, text) from public, anon, authenticated;
revoke execute on function public.mark_payout_failed(uuid, text) from public, anon, authenticated;
revoke execute on function public.partner_pipeline_for(uuid) from public, anon, authenticated;
grant execute on function public.attribute_profile(uuid, text, bigint, timestamptz) to service_role;
grant execute on function public.create_deal_commissions(uuid) to service_role;
grant execute on function public.claim_partner_payout(uuid) to service_role;
grant execute on function public.mark_payout_paid(uuid, text) to service_role;
grant execute on function public.mark_payout_failed(uuid, text) to service_role;
grant execute on function public.partner_pipeline_for(uuid) to service_role;

revoke execute on function public.become_partner(text, public.partner_type) from public, anon;
revoke execute on function public.partner_dashboard() from public, anon;
revoke execute on function public.admin_referral_overview() from public, anon;
revoke execute on function public.admin_attribute(uuid, text, text) from public, anon;
grant execute on function public.become_partner(text, public.partner_type) to authenticated;
grant execute on function public.partner_dashboard() to authenticated;
grant execute on function public.admin_referral_overview() to authenticated;
grant execute on function public.admin_attribute(uuid, text, text) to authenticated;
