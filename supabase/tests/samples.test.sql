-- Sample room tests. Run with supabase/tests/run.sh.
\set ON_ERROR_STOP on
set client_min_messages = warning;

create temp table su (name text primary key, id uuid not null);
grant select, insert on su to authenticated, service_role;
create or replace function pg_temp.sid(p text) returns uuid language sql as $$ select id from su where name = p $$;
create or replace function pg_temp.as_user(p text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(pg_temp.sid(p)::text, ''), false); end $$;
-- Runs a statement as a user and reports whether it raised.
create or replace function pg_temp.fails(p_user text, p_sql text) returns boolean language plpgsql as $$
begin
  perform pg_temp.as_user(p_user);
  begin execute p_sql; return false; exception when others then return true; end;
end $$;

do $$
declare s uuid := gen_random_uuid(); b uuid := gen_random_uuid(); x uuid := gen_random_uuid(); l uuid; n uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (s, 'dana@harbormutual.com', '{"role":"seller","full_name":"Dana","company":"Harbor Mutual"}'),
    (b, 'sam@northwind.ai',      '{"role":"buyer","full_name":"Sam","company":"Northwind AI"}'),
    (x, 'eve@other.ai',          '{"role":"buyer","full_name":"Eve","company":"Other AI"}');
  insert into su values ('seller', s), ('buyer', b), ('outsider', x);
  insert into public.listings (id, seller_id, title, status) values (gen_random_uuid(), s, 'Call recordings', 'published') returning id into l;
  insert into su values ('listing', l);
  insert into public.nda_agreements (id, listing_id, buyer_id, seller_id, buyer_signed_at) values (gen_random_uuid(), l, b, s, now()) returning id into n;
  insert into su values ('nda', n);
end $$;

-- 1. Request needs a fully signed NDA and accepted terms --------------------
set role authenticated;
do $$ begin
  assert pg_temp.fails('buyer', format('select public.request_sample(%L, ''{}'', true)', pg_temp.sid('listing'))), 'blocked before seller signs NDA';
end $$;
reset role;
update public.nda_agreements set seller_signed_at = now() where id = pg_temp.sid('nda');
set role authenticated;
do $$ declare v uuid; begin
  assert pg_temp.fails('buyer', format('select public.request_sample(%L, ''{}'', false)', pg_temp.sid('listing'))), 'terms required';
  assert pg_temp.fails('outsider', format('select public.request_sample(%L, ''{}'', true)', pg_temp.sid('listing'))), 'outsider has no NDA';
  perform pg_temp.as_user('buyer');
  v := public.request_sample(pg_temp.sid('listing'), '{"size":"~1%","note":"Spanish calls"}', true);
  insert into su values ('s1', v);
  assert pg_temp.fails('buyer', format('select public.request_sample(%L, ''{}'', true)', pg_temp.sid('listing'))), 'one open round at a time';
end $$;

-- 2. Seller shares uploaded files ------------------------------------------
do $$ begin
  assert pg_temp.fails('buyer', format('select public.share_sample(%L, ''upload'', null, 14, ''{}'')', pg_temp.sid('s1'))), 'buyer cannot share';
  assert pg_temp.fails('seller', format('select public.share_sample(%L, ''upload'', null, 14, ''{}'')', pg_temp.sid('s1'))), 'needs a verified file';
  assert pg_temp.fails('seller', format('select public.share_sample(%L, ''upload'', null, 90, ''{}'')', pg_temp.sid('s1'))), 'expiry must be 7/14/30';
  assert pg_temp.fails('seller', format('select public.share_sample(%L, ''external_link'', ''http://x.com/a'', 14, ''{}'')', pg_temp.sid('s1'))), 'external link must be https';
end $$;
reset role;
-- The server (service role) records files after verifying the objects exist.
insert into public.sample_files (id, sample_id, storage_path, file_name, size_bytes, sha256, uploaded_at)
values (gen_random_uuid(), pg_temp.sid('s1'), pg_temp.sid('s1') || '/a/calls.jsonl', 'calls.jsonl', 1024, repeat('a', 64), now()),
       (gen_random_uuid(), pg_temp.sid('s1'), pg_temp.sid('s1') || '/b/partial.wav', 'partial.wav', 2048, null, null);
insert into su select 'f1', id from public.sample_files where file_name = 'calls.jsonl';
set role authenticated;
do $$ declare e timestamptz; begin
  perform pg_temp.as_user('seller');
  e := public.share_sample(pg_temp.sid('s1'), 'upload', null, 14, '{"canary":true,"deidentified":true}');
  assert e > now() + interval '13 days', 'expires in 14 days';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.sample_files where sample_id = pg_temp.sid('s1')) = 1, 'unfinished upload dropped on share';
end $$;
set role authenticated;

-- 3. Visibility --------------------------------------------------------------
do $$ begin
  perform pg_temp.as_user('outsider');
  assert (select count(*) from public.sample_requests_view) = 0, 'outsider sees nothing';
  assert (select count(*) from public.sample_files) = 0, 'outsider sees no files';
  perform pg_temp.as_user('buyer');
  assert (select count(*) from public.sample_requests) = 0, 'buyer cannot read base table directly';
  assert (select count(*) from public.sample_requests_view) = 1, 'buyer sees the sample via the view';
  assert (select count(*) from public.sample_files) = 1, 'buyer sees files while shared';
end $$;

-- 4. Downloads: logged, limited, buyer only ----------------------------------
do $$ declare r record; i int; begin
  assert pg_temp.fails('outsider', format('select * from public.authorize_sample_access(%L, %L, null, null)', pg_temp.sid('s1'), pg_temp.sid('f1'))), 'outsider blocked';
  assert pg_temp.fails('seller', format('select * from public.authorize_sample_access(%L, %L, null, null)', pg_temp.sid('s1'), pg_temp.sid('f1'))), 'seller does not download through buyer path';
  perform pg_temp.as_user('buyer');
  select * into r from public.authorize_sample_access(pg_temp.sid('s1'), pg_temp.sid('f1'), 'iphash', 'test-agent');
  assert r.kind = 'file' and r.file_name = 'calls.jsonl' and r.target like '%/a/calls.jsonl', 'returns storage path';
  for i in 2..5 loop perform public.authorize_sample_access(pg_temp.sid('s1'), pg_temp.sid('f1'), null, null); end loop;
  assert pg_temp.fails('buyer', format('select * from public.authorize_sample_access(%L, %L, null, null)', pg_temp.sid('s1'), pg_temp.sid('f1'))), 'download limit enforced';
  perform pg_temp.as_user('seller');
  assert (select count(*) from public.sample_access_log where action = 'download') = 5, 'seller sees access log';
  perform pg_temp.as_user('outsider');
  assert (select count(*) from public.sample_access_log) = 0, 'outsider sees no log';
end $$;

-- 5. Review: validation, "again" opens round 2 --------------------------------
do $$ declare nxt uuid; begin
  assert pg_temp.fails('buyer', format('select public.review_sample(%L, ''{"dims":{"a":5}}'', ''ready'')', pg_temp.sid('s1'))), 'all five ratings required';
  assert pg_temp.fails('buyer', format('select public.review_sample(%L, ''{"dims":{"a":5,"b":4,"c":3,"d":4,"e":9}}'', ''ready'')', pg_temp.sid('s1'))), 'ratings 1-5';
  assert pg_temp.fails('buyer', format('select public.review_sample(%L, ''{"dims":{"a":5,"b":4,"c":3,"d":4,"e":4}}'', ''again'')', pg_temp.sid('s1'))), 'again needs notes';
  assert pg_temp.fails('seller', format('select public.review_sample(%L, ''{"dims":{"a":5,"b":4,"c":3,"d":4,"e":4}}'', ''ready'')', pg_temp.sid('s1'))), 'seller cannot review';
  perform pg_temp.as_user('buyer');
  nxt := public.review_sample(pg_temp.sid('s1'), '{"dims":{"a":5,"b":4,"c":3,"d":4,"e":4},"notes":"Need 2024 only"}', 'again');
  assert nxt is not null, 'round 2 created';
  insert into su values ('s2', nxt);
  assert (select round from public.sample_requests_view where id = nxt) = 2, 'round number';
  assert (select request->>'note' from public.sample_requests_view where id = nxt) = 'Need 2024 only', 'notes carried';
  assert (select deletion_due from public.sample_requests_view where id = pg_temp.sid('s1')), 'round 1 now needs deletion';
  assert pg_temp.fails('buyer', format('select * from public.authorize_sample_access(%L, %L, null, null)', pg_temp.sid('s1'), pg_temp.sid('f1'))), 'superseded sample closed';
  perform public.confirm_sample_deletion(pg_temp.sid('s1'));
  assert not (select deletion_due from public.sample_requests_view where id = pg_temp.sid('s1')), 'deletion confirmed';
end $$;

-- 6. External link round, revoke, decline -----------------------------------
do $$ declare r record; begin
  perform pg_temp.as_user('seller');
  perform public.share_sample(pg_temp.sid('s2'), 'external_link', 'https://bucket.s3.amazonaws.com/sample?sig=1', 7, '{}');
  perform pg_temp.as_user('buyer');
  assert (select external_url from public.sample_requests_view where id = pg_temp.sid('s2')) is null, 'buyer never sees the raw link';
  select * into r from public.authorize_sample_access(pg_temp.sid('s2'), null, null, null);
  assert r.kind = 'link' and r.target like 'https://bucket.s3%', 'server gets the link to redirect';
  perform pg_temp.as_user('seller');
  perform public.revoke_sample(pg_temp.sid('s2'));
  assert pg_temp.fails('buyer', format('select * from public.authorize_sample_access(%L, null, null, null)', pg_temp.sid('s2'))), 'revoked';
end $$;

-- 7. Expiry and purge (service role) -----------------------------------------
reset role;
do $$ declare v uuid; begin
  perform pg_temp.as_user('buyer');
  v := public.request_sample(pg_temp.sid('listing'), '{}', true);
  insert into su values ('s3', v);
  perform pg_temp.as_user('seller');
  perform public.decline_sample(v, 'Too large, we can do 0.5%');
  assert (select status from public.sample_requests where id = v) = 'declined', 'declined';
end $$;
-- Simulate a live sample whose window has ended.
update public.sample_requests set status = 'shared', expires_at = now() - interval '1 minute', shared_at = now() - interval '8 days', decline_reason = null
 where id = pg_temp.sid('s3');
set role service_role;
do $$ begin
  assert public.expire_samples() = 1, 'one sample expired';
  assert (select count(*) from public.sample_files_to_purge()) = 1, 'round 1 file queued for purge';
  perform public.mark_sample_files_purged(array(select file_id from public.sample_files_to_purge()));
  assert (select files_purged_at is not null from public.sample_requests where id = pg_temp.sid('s1')), 'purge recorded';
  assert (select count(*) from public.sample_files_to_purge()) = 0, 'nothing left to purge';
end $$;
reset role;
set role authenticated;
do $$ begin
  assert pg_temp.fails('buyer', 'select public.expire_samples()'), 'users cannot run housekeeping';
end $$;
reset role;

select 'samples: all tests passed' as result;

-- Enrichment markup floor ------------------------------------------------------
do $$ declare v uuid; begin
  insert into public.enrichment_orders (buyer_id, services, cost_cents, markup_bps)
  values (pg_temp.sid('buyer'), array['De-identification'], 1000000, 1200) returning id into v;
  assert (select price_cents from public.enrichment_orders where id = v) = 1120000, '12% markup applied';
  update public.enrichment_orders set cost_cents = 999 where id = v;
  assert (select price_cents from public.enrichment_orders where id = v) = 1119, 'markup rounds up';
  begin
    update public.enrichment_orders set markup_bps = 1100 where id = v;
    assert false, 'markup under 12% must fail';
  exception when check_violation then null;
  end;
end $$;
select 'enrichment: all tests passed' as result;
