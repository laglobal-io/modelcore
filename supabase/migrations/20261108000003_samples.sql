-- Sample room: buyers request a sample after the NDA, sellers share files (uploaded to a private
-- bucket) or a link to their own storage, buyers download through short-lived signed URLs, review,
-- and confirm deletion if no deal goes ahead. Every access is logged.
--
-- Custody rule: ModelCore stores samples only. Full datasets are delivered seller to buyer.
-- Sample files are deleted from storage when access expires, is revoked, or the sample is closed.

create type public.sample_status as enum (
  'requested',   -- buyer asked, seller to act
  'declined',    -- seller said no (with reason); buyer may request again
  'shared',      -- files or link available to the buyer until expires_at
  'reviewed',    -- buyer said "ready to make an offer"; access continues until expires_at
  'superseded',  -- buyer asked for another sample; a new round replaces this one
  'closed',      -- buyer said "not a fit"
  'revoked',     -- seller cut access early
  'expired'      -- access window ended
);

create table public.sample_requests (
  id                     uuid primary key default gen_random_uuid(),
  nda_id                 uuid not null references public.nda_agreements (id) on delete cascade,
  listing_id             uuid not null references public.listings (id) on delete cascade,
  buyer_id               uuid not null references public.profiles (id) on delete cascade,
  seller_id              uuid not null references public.profiles (id) on delete cascade,
  round                  integer not null default 1 check (round between 1 and 10),
  request                jsonb not null default '{}'::jsonb,  -- size, slice, fields, purpose[], needed_by, note
  terms_accepted_at      timestamptz not null,                -- evaluation-only, delete within 5 business days
  status                 public.sample_status not null default 'requested',
  decline_reason         text,
  delivery_method        text check (delivery_method in ('upload', 'external_link')),
  external_url           text,                                -- only for external_link; never shown before share
  share_details          jsonb not null default '{}'::jsonb,  -- what, format, canary, deidentified, note
  max_downloads_per_file integer not null default 5 check (max_downloads_per_file between 1 and 50),
  shared_at              timestamptz,
  expires_at             timestamptz,
  revoked_at             timestamptz,
  feedback               jsonb,                               -- dims{}, avg, issues[], notes
  verdict                text check (verdict in ('ready', 'again', 'nofit')),
  reviewed_at            timestamptz,
  deletion_confirmed_at  timestamptz,
  files_purged_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (buyer_id <> seller_id),
  check (delivery_method is distinct from 'external_link' or external_url like 'https://%')
);
create index sample_requests_nda_idx on public.sample_requests (nda_id);
create index sample_requests_buyer_idx on public.sample_requests (buyer_id);
create index sample_requests_seller_idx on public.sample_requests (seller_id);
create index sample_requests_expiry_idx on public.sample_requests (expires_at) where status in ('shared', 'reviewed');
-- One open round per NDA at a time.
create unique index sample_requests_one_open on public.sample_requests (nda_id)
  where status in ('requested', 'shared');

create trigger sample_requests_touch before update on public.sample_requests
  for each row execute function public.touch_updated_at();

create table public.sample_files (
  id            uuid primary key default gen_random_uuid(),
  sample_id     uuid not null references public.sample_requests (id) on delete cascade,
  storage_path  text not null unique,     -- samples/<sample_id>/<file_id>/<safe name>
  file_name     text not null,
  size_bytes    bigint not null check (size_bytes > 0),
  content_type  text,
  sha256        text check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at   timestamptz,              -- set once the object is verified in storage
  purged_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index sample_files_sample_idx on public.sample_files (sample_id);

create table public.sample_access_log (
  id          bigint generated always as identity primary key,
  sample_id   uuid not null references public.sample_requests (id) on delete cascade,
  file_id     uuid references public.sample_files (id) on delete set null,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null check (action in ('download', 'link_open', 'revoked', 'expired', 'purged', 'deletion_confirmed')),
  ip_hash     text,
  user_agent  text,
  at          timestamptz not null default now()
);
create index sample_access_log_sample_idx on public.sample_access_log (sample_id, at desc);

-- Private bucket. Objects are only reachable through signed URLs minted by the server.
insert into storage.buckets (id, name, public, file_size_limit)
values ('samples', 'samples', false, 5368709120)  -- 5 GB per object; raise on paid plans if needed
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.nda_fully_signed(p_nda uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.nda_agreements
                 where id = p_nda and buyer_signed_at is not null and seller_signed_at is not null);
$$;

-- True when the buyer still owes a deletion confirmation for this sample.
create or replace function public.sample_deletion_due(s public.sample_requests) returns boolean
language sql stable security definer set search_path = public as $$
  select s.shared_at is not null
     and s.deletion_confirmed_at is null
     and s.status in ('superseded', 'closed', 'revoked', 'expired')
     and not exists (
       select 1 from public.deals d
       where d.listing_id = s.listing_id and d.buyer_id = s.buyer_id
         and d.status in ('escrow_funded', 'delivered', 'released'));
$$;

-- ---------------------------------------------------------------------------
-- State changes (called as the signed-in user; each checks who is acting)
-- ---------------------------------------------------------------------------
create or replace function public.request_sample(p_listing uuid, p_request jsonb, p_accept_terms boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_nda public.nda_agreements;
  v_round integer;
  v_id uuid;
begin
  if v_uid is null then raise exception 'sign in first' using errcode = '28000'; end if;
  if not coalesce(p_accept_terms, false) then
    raise exception 'accept the evaluation-only terms to request a sample' using errcode = '22023';
  end if;
  select * into v_nda from public.nda_agreements where listing_id = p_listing and buyer_id = v_uid;
  if v_nda.id is null or not public.nda_fully_signed(v_nda.id) then
    raise exception 'both sides must sign the NDA before a sample is requested' using errcode = '42501';
  end if;
  select coalesce(max(round), 0) + 1 into v_round from public.sample_requests where nda_id = v_nda.id;
  insert into public.sample_requests (nda_id, listing_id, buyer_id, seller_id, round, request, terms_accepted_at)
  values (v_nda.id, p_listing, v_uid, v_nda.seller_id, v_round,
          coalesce(p_request, '{}'::jsonb) - 'status', now())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.decline_sample(p_sample uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.sample_requests
     set status = 'declined', decline_reason = left(coalesce(nullif(trim(p_reason), ''), 'No reason given'), 500)
   where id = p_sample and seller_id = auth.uid() and status = 'requested';
  if not found then raise exception 'sample not found or not awaiting you' using errcode = '42501'; end if;
end $$;

-- Seller shares. For uploads, every file row must be verified (uploaded_at set by the server).
create or replace function public.share_sample(
  p_sample uuid, p_method text, p_external_url text, p_expires_days integer, p_details jsonb
) returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  v_exp timestamptz;
  v_files integer;
  v_pending integer;
begin
  if p_expires_days not in (7, 14, 30) then raise exception 'access must expire after 7, 14 or 30 days' using errcode = '22023'; end if;
  if p_method not in ('upload', 'external_link') then raise exception 'unknown delivery method' using errcode = '22023'; end if;
  perform 1 from public.sample_requests where id = p_sample and seller_id = auth.uid() and status = 'requested' for update;
  if not found then raise exception 'sample not found or not awaiting you' using errcode = '42501'; end if;

  if p_method = 'upload' then
    select count(*) filter (where uploaded_at is not null), count(*) filter (where uploaded_at is null)
      into v_files, v_pending from public.sample_files where sample_id = p_sample;
    if v_files = 0 then raise exception 'upload at least one file' using errcode = '22023'; end if;
    -- Drop rows for uploads that were started but never finished.
    delete from public.sample_files where sample_id = p_sample and uploaded_at is null;
  elsif p_external_url is null or p_external_url !~ '^https://[^/\s]+\.[^/\s]+' then
    raise exception 'link must be an https URL' using errcode = '22023';
  end if;

  v_exp := now() + make_interval(days => p_expires_days);
  update public.sample_requests
     set status = 'shared', delivery_method = p_method,
         external_url = case when p_method = 'external_link' then p_external_url end,
         share_details = coalesce(p_details, '{}'::jsonb), shared_at = now(), expires_at = v_exp
   where id = p_sample;
  return v_exp;
end $$;

create or replace function public.revoke_sample(p_sample uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.sample_requests set status = 'revoked', revoked_at = now()
   where id = p_sample and seller_id = auth.uid() and status in ('shared', 'reviewed');
  if not found then raise exception 'nothing to revoke' using errcode = '42501'; end if;
  insert into public.sample_access_log (sample_id, actor_id, action) values (p_sample, auth.uid(), 'revoked');
end $$;

-- Buyer review. 'again' supersedes this round and opens the next one with the buyer's notes.
create or replace function public.review_sample(p_sample uuid, p_feedback jsonb, p_verdict text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s public.sample_requests;
  v_next uuid;
  v_dims jsonb := p_feedback -> 'dims';
  k text;
  n numeric;
begin
  select * into s from public.sample_requests where id = p_sample for update;
  if s.id is null or s.buyer_id <> auth.uid() or s.status <> 'shared' or s.expires_at <= now() then
    raise exception 'sample not available for review' using errcode = '42501';
  end if;
  if p_verdict not in ('ready', 'again', 'nofit') then raise exception 'unknown verdict' using errcode = '22023'; end if;
  if jsonb_typeof(v_dims) <> 'object' or (select count(*) from jsonb_object_keys(v_dims)) < 5 then
    raise exception 'rate all five areas' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(v_dims) loop
    n := (v_dims ->> k)::numeric;
    if n is null or n < 1 or n > 5 then raise exception 'ratings run 1 to 5' using errcode = '22023'; end if;
  end loop;
  if p_verdict <> 'ready' and coalesce(trim(p_feedback ->> 'notes'), '') = '' then
    raise exception 'add a note so the seller knows what to change' using errcode = '22023';
  end if;

  update public.sample_requests
     set feedback = p_feedback, verdict = p_verdict, reviewed_at = now(),
         status = case p_verdict when 'ready' then 'reviewed' when 'again' then 'superseded' else 'closed' end::public.sample_status
   where id = p_sample;

  if p_verdict = 'again' then
    insert into public.sample_requests (nda_id, listing_id, buyer_id, seller_id, round, request, terms_accepted_at)
    values (s.nda_id, s.listing_id, s.buyer_id, s.seller_id, s.round + 1,
            s.request || jsonb_build_object('note', p_feedback ->> 'notes', 'previous_round', s.round), now())
    returning id into v_next;
  end if;
  return v_next;
end $$;

create or replace function public.confirm_sample_deletion(p_sample uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.sample_requests set deletion_confirmed_at = now()
   where id = p_sample and buyer_id = auth.uid() and shared_at is not null and deletion_confirmed_at is null
     and status in ('superseded', 'closed', 'revoked', 'expired');
  if not found then raise exception 'nothing to confirm' using errcode = '42501'; end if;
  insert into public.sample_access_log (sample_id, actor_id, action) values (p_sample, auth.uid(), 'deletion_confirmed');
end $$;

-- Authorizes one access and logs it. Returns the storage path (upload) or URL (external link).
-- The server turns a storage path into a signed URL that lives a few minutes.
create or replace function public.authorize_sample_access(p_sample uuid, p_file uuid, p_ip_hash text, p_ua text)
returns table (kind text, target text, file_name text) language plpgsql security definer set search_path = public as $$
declare
  s public.sample_requests;
  f public.sample_files;
  v_used integer;
begin
  select * into s from public.sample_requests where id = p_sample;
  if s.id is null or s.buyer_id <> auth.uid() then raise exception 'not your sample' using errcode = '42501'; end if;
  if s.status not in ('shared', 'reviewed') then raise exception 'access to this sample has ended' using errcode = '42501'; end if;
  if s.expires_at <= now() then raise exception 'access to this sample has expired' using errcode = '42501'; end if;

  if s.delivery_method = 'external_link' then
    insert into public.sample_access_log (sample_id, actor_id, action, ip_hash, user_agent)
    values (p_sample, auth.uid(), 'link_open', p_ip_hash, left(p_ua, 300));
    return query select 'link'::text, s.external_url, null::text;
    return;
  end if;

  select * into f from public.sample_files where id = p_file and sample_id = p_sample and uploaded_at is not null and purged_at is null;
  if f.id is null then raise exception 'file not found' using errcode = '42501'; end if;
  select count(*) into v_used from public.sample_access_log
   where sample_id = p_sample and file_id = p_file and action = 'download';
  if v_used >= s.max_downloads_per_file then
    raise exception 'download limit reached for this file; ask the seller to reshare' using errcode = '42501';
  end if;
  insert into public.sample_access_log (sample_id, file_id, actor_id, action, ip_hash, user_agent)
  values (p_sample, p_file, auth.uid(), 'download', p_ip_hash, left(p_ua, 300));
  return query select 'file'::text, f.storage_path, f.file_name;
end $$;

-- ---------------------------------------------------------------------------
-- Housekeeping (service role only; called by the expiry cron)
-- ---------------------------------------------------------------------------
create or replace function public.expire_samples() returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  with x as (
    update public.sample_requests set status = 'expired'
     where status in ('shared', 'reviewed') and expires_at <= now()
    returning id)
  insert into public.sample_access_log (sample_id, action) select id, 'expired' from x;
  get diagnostics v = row_count;
  return v;
end $$;

-- Files to delete from storage: ended samples, plus uploads abandoned for over a day.
create or replace function public.sample_files_to_purge(p_limit integer default 500)
returns table (file_id uuid, sample_id uuid, storage_path text)
language sql stable security definer set search_path = public as $$
  select f.id, f.sample_id, f.storage_path
    from public.sample_files f join public.sample_requests s on s.id = f.sample_id
   where f.purged_at is null
     and (s.status in ('superseded', 'closed', 'revoked', 'expired', 'declined')
          or (f.uploaded_at is null and f.created_at < now() - interval '1 day'))
   limit p_limit;
$$;

create or replace function public.mark_sample_files_purged(p_files uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.sample_files set purged_at = now() where id = any(p_files) and purged_at is null;
  update public.sample_requests s set files_purged_at = now()
   where s.files_purged_at is null
     and s.id in (select sample_id from public.sample_files where id = any(p_files))
     and not exists (select 1 from public.sample_files f where f.sample_id = s.id and f.purged_at is null);
end $$;

revoke execute on function public.expire_samples() from public, anon, authenticated;
revoke execute on function public.sample_files_to_purge(integer) from public, anon, authenticated;
revoke execute on function public.mark_sample_files_purged(uuid[]) from public, anon, authenticated;
grant execute on function public.expire_samples() to service_role;
grant execute on function public.sample_files_to_purge(integer) to service_role;
grant execute on function public.mark_sample_files_purged(uuid[]) to service_role;
revoke execute on function public.authorize_sample_access(uuid, uuid, text, text) from public, anon;
grant execute on function public.authorize_sample_access(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: parties read; all writes go through the functions above or the service role.
-- external_url is hidden from the buyer by the sample_requests_view below.
-- ---------------------------------------------------------------------------
alter table public.sample_requests   enable row level security;
alter table public.sample_files      enable row level security;
alter table public.sample_access_log enable row level security;

create policy samples_seller_select on public.sample_requests for select to authenticated
  using (seller_id = auth.uid() or public.is_admin());
create or replace function public.sample_party(p_sample uuid, p_live_only boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.sample_requests s where s.id = p_sample
     and (s.seller_id = auth.uid() or public.is_admin()
          or (s.buyer_id = auth.uid() and (not p_live_only or (s.status in ('shared', 'reviewed') and s.expires_at > now())))));
$$;

create policy sample_files_party_select on public.sample_files for select to authenticated
  using (public.sample_party(sample_id, true));
-- Sellers see who opened what. Buyers see their own access history.
create policy sample_log_party_select on public.sample_access_log for select to authenticated
  using (actor_id = auth.uid() or (public.sample_party(sample_id, false)
         and exists (select 1 from public.sample_requests s where s.id = sample_id and s.seller_id = auth.uid())));

-- What both parties read in the app. Buyers never see the raw external URL (they open it via the
-- server, which logs the access); they see storage paths for nothing.
create or replace view public.sample_requests_view with (security_barrier = true) as
  select s.id, s.nda_id, s.listing_id, s.buyer_id, s.seller_id, s.round, s.request, s.status,
         s.decline_reason, s.delivery_method,
         case when s.seller_id = auth.uid() then s.external_url end as external_url,
         s.share_details, s.max_downloads_per_file, s.shared_at, s.expires_at, s.revoked_at,
         s.feedback, s.verdict, s.reviewed_at, s.deletion_confirmed_at, s.files_purged_at,
         public.sample_deletion_due(s) as deletion_due, s.created_at, s.updated_at
    from public.sample_requests s
   where s.buyer_id = auth.uid() or s.seller_id = auth.uid() or public.is_admin();
grant select on public.sample_requests_view to authenticated;
