-- Data enrichment orders: run by ModelCore between seller and buyer (or on a buyer's own data).
-- Price = cost * (1 + markup). Markup is internal and never below 12%.

insert into public.app_settings (key, value)
values ('enrichment_min_markup_bps', '1200'::jsonb), ('enrichment_default_markup_bps', '1500'::jsonb)
on conflict (key) do nothing;

create type public.enrichment_status as enum ('requested', 'quoted', 'approved', 'running', 'delivered', 'cancelled');

create table public.enrichment_orders (
  id            uuid primary key default gen_random_uuid(),
  buyer_id      uuid not null references public.profiles (id) on delete cascade,
  deal_id       uuid references public.deals (id) on delete set null,   -- null when it's the buyer's own data
  services      text[] not null check (cardinality(services) > 0),
  brief         text,
  status        public.enrichment_status not null default 'requested',
  cost_cents    bigint check (cost_cents >= 0),                         -- vendor + labor cost, internal
  markup_bps    integer not null default 1500 check (markup_bps >= 1200), -- at least 12% on top of cost
  price_cents   bigint generated always as (cost_cents + (cost_cents * markup_bps + 9999) / 10000) stored,
  quoted_at     timestamptz,
  approved_at   timestamptz,
  delivered_at  timestamptz,
  data_purged_at timestamptz,                                            -- deleted from the pipeline after delivery
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index enrichment_orders_buyer_idx on public.enrichment_orders (buyer_id);
create trigger enrichment_orders_touch before update on public.enrichment_orders
  for each row execute function public.touch_updated_at();

-- Never let a quote go out under the floor, even if the setting is raised later.
create or replace function public.enforce_enrichment_markup() returns trigger
language plpgsql as $$
declare v_min integer := coalesce((select (value)::text::integer from public.app_settings where key = 'enrichment_min_markup_bps'), 1200);
begin
  if new.markup_bps < greatest(v_min, 1200) then
    raise exception 'enrichment markup must be at least % bps', greatest(v_min, 1200) using errcode = '23514';
  end if;
  return new;
end $$;
create trigger enrichment_orders_markup before insert or update of markup_bps on public.enrichment_orders
  for each row execute function public.enforce_enrichment_markup();

alter table public.enrichment_orders enable row level security;
-- Buyers see their orders and the quoted price; cost and markup are hidden by the view below.
create policy enrichment_admin_all on public.enrichment_orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace view public.enrichment_orders_buyer with (security_barrier = true) as
  select id, deal_id, services, brief, status,
         case when status in ('quoted', 'approved', 'running', 'delivered') then price_cents end as price_cents,
         quoted_at, approved_at, delivered_at, created_at
    from public.enrichment_orders
   where buyer_id = auth.uid();
grant select on public.enrichment_orders_buyer to authenticated;
