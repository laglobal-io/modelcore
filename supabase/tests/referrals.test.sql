-- Referral system tests. Run with supabase/tests/run.sh (plain Postgres + auth stub).
\set ON_ERROR_STOP on
set client_min_messages = warning;

create temp table u (name text primary key, id uuid not null);
grant select on u to authenticated;
create or replace function pg_temp.uid(p text) returns uuid language sql as $$ select id from u where name = p $$;
create or replace function pg_temp.signup(p_name text, p_email text, p_meta jsonb) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data) values (v, p_email, p_meta);
  insert into u values (p_name, v);
  return v;
end $$;
create or replace function pg_temp.act_as(p_name text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(pg_temp.uid(p_name)::text, ''), false); end $$;

-- 1. Partners sign up and claim codes ---------------------------------------
select pg_temp.signup('alice', 'alice@vcfund.com', '{"role":"seller","full_name":"Alice Partner","company":"VC Fund"}');
select pg_temp.signup('frank', 'frank@brokerco.com', '{"role":"buyer","full_name":"Frank Broker","company":"Broker Co"}');

select pg_temp.act_as('alice');
set role authenticated;
select code from public.become_partner('VCFund', 'sell_side');
reset role;
select pg_temp.act_as('frank');
set role authenticated;
select code from public.become_partner('broker', 'buy_side');
reset role;

do $$ begin
  begin
    perform set_config('request.jwt.claim.sub', pg_temp.uid('frank')::text, false);
    perform public.become_partner('admin');  -- frank already has a code, returns existing
  end;
  assert (select code from public.partners where profile_id = pg_temp.uid('frank')) = 'broker', 'existing partner keeps code';
end $$;

do $$
declare ok boolean := false;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'zed@zed.io');
  perform set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'zed@zed.io'), false);
  begin perform public.become_partner('admin'); exception when others then ok := sqlerrm like '%reserved%'; end;
  assert ok, 'reserved code rejected';
  ok := false;
  begin perform public.become_partner('a!'); exception when others then ok := sqlerrm like '%3-32%'; end;
  assert ok, 'invalid code rejected';
  ok := false;
  begin perform public.become_partner('broker'); exception when others then ok := sqlerrm like '%taken%'; end;
  assert ok, 'duplicate code rejected';
end $$;
select set_config('request.jwt.claim.sub', '', false);

-- 2. Link click then signup -> 'link' attribution anchored at click time -------
insert into public.referral_clicks (partner_id, visitor_id, landing_path, created_at)
select id, gen_random_uuid(), '/', now() - interval '10 days' from public.partners where code = 'vcfund';

select pg_temp.signup('bob', 'bob@harbormutual.com', jsonb_build_object(
  'role','seller','full_name','Bob Owner','company','Harbor Mutual',
  'ref_code','VCFUND','ref_click_id',(select max(id) from public.referral_clicks)));

do $$
declare a public.referral_attributions;
begin
  select * into a from public.referral_attributions where profile_id = pg_temp.uid('bob');
  assert found, 'bob attributed';
  assert a.source = 'link', 'bob source is link, got ' || a.source;
  assert a.first_touch_at < now() - interval '9 days', 'first touch is the click time';
  assert a.expires_at = a.first_touch_at + interval '24 months', 'window is 24 months from first touch';
  assert (select company_domain from public.profiles where id = pg_temp.uid('bob')) = 'harbormutual.com', 'domain stored';
end $$;

-- 3. Colleague with no code inherits via company domain -------------------------
select pg_temp.signup('carol', 'carol@harbormutual.com', '{"role":"seller","full_name":"Carol Colleague"}');
do $$
declare a public.referral_attributions; b public.referral_attributions;
begin
  select * into a from public.referral_attributions where profile_id = pg_temp.uid('carol');
  select * into b from public.referral_attributions where profile_id = pg_temp.uid('bob');
  assert found, 'carol inherited';
  assert a.source = 'domain' and a.inherited_from = b.id and a.expires_at = b.expires_at, 'inherits same window';
end $$;

-- 4. Referring your own company earns nothing ---------------------------------
select pg_temp.signup('dave', 'dave@vcfund.com', '{"role":"buyer","ref_code":"vcfund"}');
do $$ begin
  assert not exists (select 1 from public.referral_attributions where profile_id = pg_temp.uid('dave')), 'no self-company credit';
end $$;

-- 5. Free-mail: code works, but no domain inheritance ----------------------------
select pg_temp.signup('gail', 'gail@gmail.com', '{"role":"seller","ref_code":"broker"}');
select pg_temp.signup('hank', 'hank@gmail.com', '{"role":"seller"}');
do $$ begin
  assert (select source from public.referral_attributions where profile_id = pg_temp.uid('gail')) = 'code', 'gail via code';
  assert (select company_domain from public.profiles where id = pg_temp.uid('gail')) is null, 'free-mail domain not stored';
  assert not exists (select 1 from public.referral_attributions where profile_id = pg_temp.uid('hank')), 'no gmail inheritance';
end $$;

-- 6. Metadata cannot grant admin or an invalid role --------------------------
select pg_temp.signup('mallory', 'm@evil.io', '{"role":"admin","is_admin":true}');
do $$ begin
  assert (select role from public.profiles where id = pg_temp.uid('mallory')) = 'seller', 'invalid role falls back';
  assert not (select is_admin from public.profiles where id = pg_temp.uid('mallory')), 'metadata cannot set admin';
end $$;
select pg_temp.act_as('mallory');
set role authenticated;
update public.profiles set is_admin = true where id = auth.uid();
reset role;
do $$ begin
  assert not (select is_admin from public.profiles where id = pg_temp.uid('mallory')), 'user cannot self-promote';
end $$;

-- 7. Buyers ------------------------------------------------------------------
select pg_temp.signup('erin', 'erin@northwind.ai', '{"role":"buyer","company":"Northwind AI","ref_code":"vcfund"}');
select pg_temp.signup('gina', 'gina@labco.ai', '{"role":"buyer","company":"LabCo","ref_code":"broker"}');
select pg_temp.signup('ivan', 'ivan@plainbuyer.ai', '{"role":"buyer","company":"Plain Buyer"}');

-- 8. Deal released: each referred side pays its partner 25% of the 10% fee --------
insert into public.deals (id, seller_id, buyer_id, amount_cents, status)
values ('00000000-0000-0000-0000-0000000000d1', pg_temp.uid('bob'), pg_temp.uid('gina'), 25000000, 'escrow_funded');
update public.deals set status = 'released' where id = '00000000-0000-0000-0000-0000000000d1';

do $$
declare s public.referral_commissions; b public.referral_commissions;
begin
  select * into s from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d1' and side = 'seller';
  select * into b from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d1' and side = 'buyer';
  assert s.platform_fee_cents = 2500000, 'fee is 10%';
  assert s.commission_cents = 625000 and s.status = 'approved', 'seller-side partner earns $6,250';
  assert b.commission_cents = 625000, 'buyer-side partner earns $6,250';
  assert s.partner_id = (select id from public.partners where code = 'vcfund'), 'seller side to vcfund';
  assert b.partner_id = (select id from public.partners where code = 'broker'), 'buyer side to broker';
  assert (select released_at from public.deals where id = '00000000-0000-0000-0000-0000000000d1') is not null, 'released_at stamped';
end $$;

-- Idempotent: rerunning does not duplicate
select count(*) from public.create_deal_commissions('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  assert (select count(*) from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d1') = 2, 'no duplicates';
end $$;

-- 9. Same partner on both sides is paid once --------------------------------
insert into public.deals (id, seller_id, buyer_id, amount_cents, status)
values ('00000000-0000-0000-0000-0000000000d2', pg_temp.uid('carol'), pg_temp.uid('erin'), 10000000, 'escrow_funded');
update public.deals set status = 'released' where id = '00000000-0000-0000-0000-0000000000d2';
do $$ begin
  assert (select count(*) from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d2') = 1, 'one commission when same partner';
  assert (select commission_cents from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d2') = 250000, '$2,500 on $100k';
end $$;

-- 10. Unreferred parties: nothing --------------------------------------------
insert into public.deals (id, seller_id, buyer_id, amount_cents, status)
values ('00000000-0000-0000-0000-0000000000d3', pg_temp.uid('hank'), pg_temp.uid('ivan'), 5000000, 'escrow_funded');
update public.deals set status = 'released' where id = '00000000-0000-0000-0000-0000000000d3';
do $$ begin
  assert not exists (select 1 from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d3'), 'no commission';
end $$;

-- 11. Expired attribution: nothing -------------------------------------------
update public.referral_attributions set expires_at = now() - interval '1 day' where profile_id = pg_temp.uid('gail');
insert into public.deals (id, seller_id, buyer_id, amount_cents, status)
values ('00000000-0000-0000-0000-0000000000d4', pg_temp.uid('gail'), pg_temp.uid('ivan'), 5000000, 'escrow_funded');
update public.deals set status = 'released' where id = '00000000-0000-0000-0000-0000000000d4';
do $$ begin
  assert not exists (select 1 from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d4'), 'expired window pays nothing';
end $$;

-- 12. Refund voids unpaid commissions ----------------------------------------
insert into public.deals (id, seller_id, buyer_id, amount_cents, status)
values ('00000000-0000-0000-0000-0000000000d5', pg_temp.uid('bob'), pg_temp.uid('ivan'), 3333333, 'escrow_funded');
update public.deals set status = 'released' where id = '00000000-0000-0000-0000-0000000000d5';
do $$ begin
  -- fee rounds half-up (333,333.3 -> 333,333), commission rounds down (83,333.25 -> 83,333)
  assert (select commission_cents from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d5') = 83333, 'rounding';
end $$;
update public.deals set status = 'refunded' where id = '00000000-0000-0000-0000-0000000000d5';
do $$ begin
  assert (select status from public.referral_commissions where deal_id = '00000000-0000-0000-0000-0000000000d5') = 'void', 'refund voids';
end $$;

-- 13. Payouts ----------------------------------------------------------------
update public.partners set payouts_enabled = true, stripe_account_id = 'acct_vc' where code = 'vcfund';
update public.partners set payouts_enabled = true, stripe_account_id = 'acct_br' where code = 'broker';

do $$
declare p public.partner_payouts; pid uuid := (select id from public.partners where code = 'vcfund');
begin
  p := public.claim_partner_payout(pid);
  assert p.amount_cents = 625000 + 250000, 'vcfund payout sums approved, got ' || p.amount_cents;
  assert public.claim_partner_payout(pid) is null, 'no second payout while processing';
  perform public.mark_payout_paid(p.id, 'tr_123');
  assert (select count(*) from public.referral_commissions where partner_id = pid and status = 'paid') = 2, 'commissions paid';
  assert public.claim_partner_payout(pid) is null, 'nothing left to pay';
end $$;

do $$
declare p public.partner_payouts; pid uuid := (select id from public.partners where code = 'broker');
begin
  p := public.claim_partner_payout(pid);
  perform public.mark_payout_failed(p.id, 'account restricted');
  assert (select status from public.partner_payouts where id = p.id) = 'failed', 'payout failed';
  assert (select count(*) from public.referral_commissions where partner_id = pid and status = 'approved' and payout_id is null) = 1,
    'failed payout releases commissions for retry';
  p := public.claim_partner_payout(pid);
  assert p.amount_cents = 625000, 'retry works';
end $$;

-- Minimum payout threshold
update public.app_settings set value = '1000000' where key = 'min_payout_cents';
insert into public.deals (id, seller_id, buyer_id, amount_cents, status)
values ('00000000-0000-0000-0000-0000000000d6', pg_temp.uid('carol'), pg_temp.uid('ivan'), 1000000, 'escrow_funded');
update public.deals set status = 'released' where id = '00000000-0000-0000-0000-0000000000d6';
do $$ begin
  assert public.claim_partner_payout((select id from public.partners where code = 'vcfund')) is null, 'below minimum';
end $$;
update public.app_settings set value = '5000' where key = 'min_payout_cents';

-- 14. RLS and dashboards -------------------------------------------------------
select pg_temp.act_as('ivan');
set role authenticated;
do $$ begin
  assert (select count(*) from public.referral_commissions) = 0, 'non-partner sees no commissions';
  assert (select count(*) from public.referral_attributions) = 0, 'non-partner sees no attributions';
  assert public.partner_dashboard() is null, 'non-partner dashboard is null';
end $$;
reset role;

select pg_temp.act_as('alice');
set role authenticated;
do $$
declare d jsonb := public.partner_dashboard();
begin
  assert (select count(*) from public.referral_clicks) = 0, 'partners cannot read raw clicks';
  assert (select count(*) from public.referral_attributions) = 3, 'alice sees bob, carol, erin';
  assert (d->'stats'->>'signups')::int = 3, 'dashboard signups';
  assert (d->'stats'->>'clicks_total')::int = 1, 'dashboard clicks';
  assert (d->'stats'->>'paid_cents')::bigint = 875000, 'dashboard paid';
  assert (d->'stats'->>'approved_cents')::bigint = 25000, 'dashboard owed (d6)';
  assert jsonb_array_length(d->'pipeline') = 3, 'pipeline rows';
  assert exists (select 1 from jsonb_array_elements(d->'pipeline') e where e->>'company' = 'Harbor Mutual' and e->>'stage' = 'deal_closed'), 'stage deal_closed';
  assert (d->'partner'->>'share_bps')::int = 2500, 'share shown';
end $$;
do $$
declare ok boolean := false;
begin
  begin perform public.admin_referral_overview(); exception when others then ok := true; end;
  assert ok, 'admin overview blocked for partners';
  ok := false;
  begin perform public.claim_partner_payout((select id from public.partners where profile_id = auth.uid())); exception when insufficient_privilege then ok := true; end;
  assert ok, 'partners cannot claim payouts directly';
end $$;
reset role;

select set_config('request.jwt.claim.sub', '', false);  -- service-level write, no user session
update public.profiles set is_admin = true where id = pg_temp.uid('frank');
select pg_temp.act_as('frank');
set role authenticated;
do $$
declare o jsonb := public.admin_referral_overview(); a public.referral_attributions;
begin
  assert (o->'totals'->>'partners')::int = 2, 'admin sees partners';
  a := public.admin_attribute(pg_temp.uid('ivan'), 'vcfund', 'Intro at conference');
  assert a.source = 'manual' and a.created_by = pg_temp.uid('frank'), 'manual attribution';
end $$;
reset role;

select 'ALL REFERRAL TESTS PASSED' as result;
