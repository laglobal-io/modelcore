-- ModelCore core marketplace schema
-- Profiles, listings, data requests, NDAs and deals. Referral tables live in the next migration.

create extension if not exists citext;

create type public.user_role as enum ('seller', 'buyer', 'expert');
create type public.listing_status as enum ('draft', 'in_review', 'published', 'archived');
create type public.listing_visibility as enum ('public', 'private');
create type public.deal_status as enum (
  'offered', 'accepted', 'escrow_funded', 'delivered', 'released', 'cancelled', 'refunded'
);

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users, created by trigger on signup)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  role              public.user_role not null default 'seller',
  full_name         text not null default '',
  email             citext not null,
  company           text,
  company_domain    citext,            -- derived from work email, null for free-mail domains
  website           text,
  phone             text,
  intake            jsonb not null default '{}'::jsonb,  -- onboarding answers
  is_admin          boolean not null default false,      -- never settable from signup metadata
  stripe_account_id text unique,                          -- Stripe Connect account for seller payouts
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index profiles_company_domain_idx on public.profiles (company_domain);

-- ---------------------------------------------------------------------------
-- Listings and buyer requests
-- ---------------------------------------------------------------------------
create table public.listings (
  id          uuid primary key default gen_random_uuid(),
  seller_id   uuid not null references public.profiles (id) on delete cascade,
  title       text not null,
  modality    text,
  industry    text,
  size_label  text,
  formats     text[] not null default '{}',
  pii_status  text,
  details     jsonb not null default '{}'::jsonb,
  status      public.listing_status not null default 'draft',
  visibility  public.listing_visibility not null default 'public',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index listings_seller_idx on public.listings (seller_id);
create index listings_status_idx on public.listings (status, visibility);

create table public.data_requests (
  id           uuid primary key default gen_random_uuid(),
  buyer_id     uuid not null references public.profiles (id) on delete cascade,
  title        text not null,
  details      text,
  budget_label text,
  needed_by    text,
  status       text not null default 'open' check (status in ('open', 'closed')),
  created_at   timestamptz not null default now()
);
create index data_requests_buyer_idx on public.data_requests (buyer_id);

-- ---------------------------------------------------------------------------
-- Mutual NDA + non-circumvention, signed per listing per buyer
-- ---------------------------------------------------------------------------
create table public.nda_agreements (
  id                uuid primary key default gen_random_uuid(),
  listing_id        uuid not null references public.listings (id) on delete cascade,
  buyer_id          uuid not null references public.profiles (id) on delete cascade,
  seller_id         uuid not null references public.profiles (id) on delete cascade,
  terms_version     text not null default 'v1',
  buyer_signed_at   timestamptz,
  buyer_signature   text,
  seller_signed_at  timestamptz,
  seller_signature  text,
  created_at        timestamptz not null default now(),
  unique (listing_id, buyer_id)
);

-- ---------------------------------------------------------------------------
-- Deals: escrow via Stripe "separate charges and transfers"
--   buyer pays platform -> on release, platform transfers (amount - fee) to seller
-- ---------------------------------------------------------------------------
create table public.deals (
  id                        uuid primary key default gen_random_uuid(),
  listing_id                uuid references public.listings (id) on delete set null,
  seller_id                 uuid not null references public.profiles (id),
  buyer_id                  uuid not null references public.profiles (id),
  amount_cents              bigint not null check (amount_cents > 0),
  currency                  text not null default 'usd',
  platform_fee_bps          integer not null default 1000 check (platform_fee_bps between 0 and 10000),
  scope                     text,
  status                    public.deal_status not null default 'offered',
  stripe_payment_intent_id  text unique,
  stripe_transfer_id        text unique,
  escrow_funded_at          timestamptz,
  delivered_at              timestamptz,
  released_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  check (seller_id <> buyer_id)
);
create index deals_seller_idx on public.deals (seller_id);
create index deals_buyer_idx on public.deals (buyer_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger listings_touch before update on public.listings
  for each row execute function public.touch_updated_at();
create trigger deals_touch before update on public.deals
  for each row execute function public.touch_updated_at();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Users may edit their own profile but never these columns.
create or replace function public.guard_profile_columns() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.is_admin := old.is_admin;
    new.stripe_account_id := old.stripe_account_id;
    new.email := old.email;
    new.company_domain := old.company_domain;
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_columns();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.listings       enable row level security;
alter table public.data_requests  enable row level security;
alter table public.nda_agreements enable row level security;
alter table public.deals          enable row level security;

create policy profiles_self_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- The catalog is members-only: any signed-in user sees published public listings.
create policy listings_member_select on public.listings for select to authenticated
  using ((status = 'published' and visibility = 'public') or seller_id = auth.uid() or public.is_admin());
create policy listings_owner_insert on public.listings for insert to authenticated
  with check (seller_id = auth.uid() and status in ('draft', 'in_review'));
create policy listings_owner_update on public.listings for update to authenticated
  using (seller_id = auth.uid()) with check (seller_id = auth.uid());

-- Requests are public, so logged-out visitors can see demand.
create policy requests_public_select on public.data_requests for select to anon, authenticated
  using (status = 'open' or buyer_id = auth.uid());
create policy requests_owner_insert on public.data_requests for insert to authenticated
  with check (buyer_id = auth.uid());
create policy requests_owner_update on public.data_requests for update to authenticated
  using (buyer_id = auth.uid()) with check (buyer_id = auth.uid());

create policy nda_party_select on public.nda_agreements for select to authenticated
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_admin());
create policy nda_buyer_insert on public.nda_agreements for insert to authenticated
  with check (buyer_id = auth.uid());

-- Deals are read-only to the parties; all writes go through server routes with the service role.
create policy deals_party_select on public.deals for select to authenticated
  using (buyer_id = auth.uid() or seller_id = auth.uid() or public.is_admin());
