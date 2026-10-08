begin;

alter table public.chestny_enrichment_runs drop constraint if exists chestny_enrichment_runs_status_check;
alter table public.chestny_enrichment_runs add constraint chestny_enrichment_runs_status_check
  check(status in ('awaiting_approval','approved','running','paused','completed','cancelled'));
alter table public.chestny_enrichment_runs add column if not exists pause_reason jsonb;

-- Existing unresolved decisions are never allowed to remain public.
update public.vehicles v set is_public = false
where is_public and not exists (
  select 1 from public.listing_screening s where s.source_listing_id=v.source_listing_id and s.decision='approved'
    and not (s.is_lease or s.is_rental or s.is_taxi or s.is_commercial or s.is_problematic)
);

alter table public.listing_screening drop constraint if exists listing_screening_decision_check;
update public.listing_screening set decision='isolated', is_problematic=true,
  details=details || jsonb_build_object('legacyDecision','manual_review','evidence',jsonb_build_array(jsonb_build_object(
    'code','legacy_decision_unresolved','explanation','Старое решение требует автоматической повторной проверки исходных данных.',
    'values',jsonb_build_object('reasonCodes',reason_codes,'previousDetails',details),'source','listing_screening before migration','observedAt',now()))),
  rules_version='2026-10-07.1', screened_at=now()
where decision='manual_review';
alter table public.listing_screening add constraint listing_screening_decision_check check(decision in ('pending','approved','rejected','isolated'));

create or replace function public.validate_screening_evidence() returns trigger language plpgsql set search_path='' as $$
declare e jsonb; c text;
begin
  if new.rules_version='2026-10-07.1' and new.decision in ('isolated','rejected') then
    if jsonb_typeof(new.details->'evidence') is distinct from 'array' or jsonb_array_length(new.details->'evidence')=0 then raise exception 'Screening requires decision evidence'; end if;
    for e in select value from jsonb_array_elements(new.details->'evidence') loop
      if coalesce(e->>'code','')='' or coalesce(e->>'explanation','')='' or coalesce(e->>'source','')='' or coalesce(e->>'observedAt','')=''
        or jsonb_typeof(e->'values') is distinct from 'object' then raise exception 'Screening evidence is incomplete'; end if;
    end loop;
    foreach c in array new.reason_codes loop
      if not exists(select 1 from jsonb_array_elements(new.details->'evidence') x where x->>'code'=c) then raise exception 'Screening reason % lacks evidence',c; end if;
    end loop;
  end if;
  return new;
end; $$;
create trigger screening_requires_evidence before insert or update on public.listing_screening
for each row execute function public.validate_screening_evidence();

create table public.chestny_catalog_decisions (
  source_listing_id text primary key,
  run_id uuid references public.chestny_enrichment_runs(id),
  decision text not null check(decision in ('approved','rejected','isolated')),
  rules_version text not null,
  evidence jsonb not null check(jsonb_typeof(evidence)='array'),
  proof jsonb,
  decided_at timestamptz not null default now()
);
alter table public.chestny_catalog_decisions enable row level security;
revoke all on public.chestny_catalog_decisions from anon, authenticated;
grant all on public.chestny_catalog_decisions to service_role;

create or replace function public.record_chestny_queue_decision() returns trigger language plpgsql security definer set search_path='' as $$
declare v_decision text := new.result->>'screeningDecision';
begin
  if v_decision in ('approved','rejected','isolated') then
    if v_decision <> 'approved' and jsonb_array_length(coalesce(new.result->'reasonEvidence','[]'::jsonb))=0 then
      raise exception 'Final decision requires evidence';
    end if;
    insert into public.chestny_catalog_decisions(source_listing_id,run_id,decision,rules_version,evidence,proof)
      values(new.source_listing_id,new.run_id,v_decision,'2026-10-07.1',coalesce(new.result->'reasonEvidence','[]'::jsonb),new.result->'publicationGate')
      on conflict(source_listing_id) do update set run_id=excluded.run_id,decision=excluded.decision,
        rules_version=excluded.rules_version,evidence=excluded.evidence,proof=excluded.proof,decided_at=now();
  end if;
  return new;
end; $$;
create trigger chestny_queue_decision after update of result on public.chestny_enrichment_queue
for each row execute function public.record_chestny_queue_decision();

create or replace function public.hide_vehicle_when_screening_changes() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    update public.vehicles set is_public=false where source_listing_id=old.source_listing_id and is_public;
    return old;
  end if;
  if new.decision <> 'approved' or new.is_lease or new.is_rental or new.is_taxi or new.is_commercial or new.is_problematic
    or new.details->'publicationGate'->>'validated' is distinct from 'true' then
    update public.vehicles set is_public=false where source_listing_id=new.source_listing_id and is_public;
  end if;
  return new;
end; $$;
create trigger screening_hides_unapproved after update or delete on public.listing_screening
for each row execute function public.hide_vehicle_when_screening_changes();

-- Source identifier ownership is immutable. A competing writer cannot steal a link.
create or replace function public.prevent_identifier_reassignment() returns trigger language plpgsql set search_path='' as $$
begin
  if new.vehicle_id <> old.vehicle_id then raise exception 'identity_source_identifier_collision: %',old.source_identifier; end if;
  return new;
end; $$;
create trigger immutable_source_identifier before update of vehicle_id on public.vehicle_source_identifiers
for each row execute function public.prevent_identifier_reassignment();

alter table public.vehicle_reports alter column report_status drop not null;

create table public.chestny_catalog_launches (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null unique,
  rules jsonb not null,
  baseline_counts jsonb not null,
  baseline_at timestamptz not null default now(),
  status text not null default 'capturing' check(status in ('capturing','prepared','running','completed','cancelled'))
);
create table public.chestny_catalog_launch_quotas (
  launch_id uuid references public.chestny_catalog_launches(id) on delete cascade,
  manufacturer text not null,
  target integer not null check(target>0),
  baseline_public_count integer not null,
  primary key(launch_id,manufacturer)
);
create table public.chestny_catalog_launch_baseline_identifiers (
  launch_id uuid references public.chestny_catalog_launches(id) on delete cascade,
  source_identifier text not null,
  primary key(launch_id,source_identifier)
);
create table public.chestny_catalog_publication_credits (
  launch_id uuid not null references public.chestny_catalog_launches(id),
  vehicle_id uuid not null references public.vehicles(id),
  source_listing_id text not null,
  manufacturer text not null,
  first_credited_at timestamptz not null default now(),
  primary key(launch_id,source_listing_id),
  unique(launch_id,vehicle_id)
);
alter table public.vehicles add column catalog_launch_id uuid references public.chestny_catalog_launches(id);

do $$ declare t text; begin
  foreach t in array array['chestny_catalog_launches','chestny_catalog_launch_quotas','chestny_catalog_launch_baseline_identifiers','chestny_catalog_publication_credits'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end; $$;

create view public.chestny_catalog_launch_progress with (security_invoker=true) as
select q.launch_id,q.manufacturer,q.target,q.baseline_public_count,
  count(c.vehicle_id)::integer as credited_publications,
  count(c.vehicle_id) filter(where v.is_public and v.status='active')::integer as published,
  greatest(0,q.target-count(c.vehicle_id) filter(where v.is_public and v.status='active'))::integer as remaining
from public.chestny_catalog_launch_quotas q
left join public.chestny_catalog_publication_credits c on c.launch_id=q.launch_id and c.manufacturer=q.manufacturer
left join public.vehicles v on v.id=c.vehicle_id group by q.launch_id,q.manufacturer,q.target,q.baseline_public_count;
grant select on public.chestny_catalog_launch_progress to service_role;
revoke all on public.chestny_catalog_launch_progress from anon,authenticated;

create or replace function public.enforce_vehicle_publication() returns trigger language plpgsql security definer set search_path='' as $$
declare s public.listing_screening; q public.chestny_catalog_launch_quotas; v_new_publication boolean; v_used integer;
begin
  if not new.is_public then return new; end if;
  select * into s from public.listing_screening where source_listing_id=new.source_listing_id for share;
  if s.source_listing_id is null or s.decision <> 'approved' or s.is_lease or s.is_rental or s.is_taxi or s.is_commercial or s.is_problematic then
    raise exception 'Listing % has not passed publication screening',new.source_listing_id;
  end if;
  v_new_publication := tg_op='INSERT';
  if tg_op='UPDATE' then
    v_new_publication := not old.is_public or old.source_listing_id <> new.source_listing_id or old.catalog_launch_id is distinct from new.catalog_launch_id;
    if old.catalog_launch_id is not null and (old.catalog_launch_id is distinct from new.catalog_launch_id or old.manufacturer<>new.manufacturer) then
      raise exception 'Publication launch and credited brand are immutable';
    end if;
  end if;
  if v_new_publication then
    if s.rules_version <> '2026-10-07.1' or s.details->'publicationGate'->>'validated' is distinct from 'true'
      or s.details->'publicationGate'->>'canonicalId' is distinct from new.source_listing_id then
      raise exception 'Listing % requires a current integrity gate',new.source_listing_id;
    end if;
    if new.model_year<2016 or new.mileage_km>190000 or new.price_krw<=0 or new.price_usd is null
      or new.engine_cc is null or new.engine_cc<=0 then raise exception 'Catalogue characteristics are incomplete'; end if;
    if new.source_updated_at is null or new.source_updated_at < now()-interval '180 days' then raise exception 'Listing freshness unconfirmed'; end if;
    if s.details->'publicationGate'->'normalized' is distinct from jsonb_build_object(
      'manufacturer',new.manufacturer,'model',new.model,'modelYear',new.model_year,'mileageKm',new.mileage_km,
      'engineCc',new.engine_cc,'fuelType',new.fuel_type,'transmission',new.transmission,'priceKrw',new.price_krw) then
      raise exception 'Normalized catalogue fields conflict with validated payload';
    end if;
    if (select count(*) from public.vehicle_images where vehicle_id=new.id)<5 then raise exception 'Catalogue requires five photographs'; end if;
    if not exists(select 1 from public.vehicle_reports where vehicle_id=new.id and canonical_vehicle_id=new.source_listing_id and report_status in ('ready','unavailable')) then
      raise exception 'Report result is not confirmed';
    end if;
  end if;
  if new.catalog_launch_id is not null and v_new_publication then
    if not exists(select 1 from public.chestny_catalog_launches where id=new.catalog_launch_id and status in ('prepared','running')) then raise exception 'Launch is not active'; end if;
    if exists(select 1 from public.chestny_catalog_launch_baseline_identifiers where launch_id=new.catalog_launch_id and source_identifier=new.source_listing_id) then raise exception 'Existing baseline listing cannot be counted as new'; end if;
    select * into q from public.chestny_catalog_launch_quotas where launch_id=new.catalog_launch_id and manufacturer=new.manufacturer for update;
    if q.manufacturer is null then raise exception 'Brand has no approved quota'; end if;
    select count(*) into v_used from public.chestny_catalog_publication_credits c join public.vehicles v on v.id=c.vehicle_id
      where c.launch_id=new.catalog_launch_id and c.manufacturer=new.manufacturer and v.is_public and v.id<>new.id;
    if v_used>=q.target then raise exception 'Brand quota reached'; end if;
  end if;
  new.published_at=coalesce(new.published_at,now());
  return new;
end; $$;
drop trigger vehicles_enforce_publication on public.vehicles;
create trigger vehicles_enforce_publication before insert or update of is_public,source_listing_id,catalog_launch_id,manufacturer on public.vehicles
for each row execute function public.enforce_vehicle_publication();

create or replace function public.credit_chestny_publication() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.is_public and new.catalog_launch_id is not null then
    insert into public.chestny_catalog_publication_credits(launch_id,vehicle_id,source_listing_id,manufacturer)
      values(new.catalog_launch_id,new.id,new.source_listing_id,new.manufacturer) on conflict do nothing;
  end if;
  return new;
end; $$;
create trigger chestny_publication_credit after insert or update of is_public on public.vehicles
for each row execute function public.credit_chestny_publication();

create or replace function public.prepare_chestny_catalog_launch(p_name text, p_quotas jsonb, p_rules jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_counts jsonb; v_total integer; v_brands integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_name));
  select id into v_id from public.chestny_catalog_launches where name=p_name;
  if v_id is not null then if exists(select 1 from public.chestny_catalog_launches where id=v_id and status<>'prepared') then raise exception 'Launch baseline capture is incomplete'; end if; return v_id; end if;
  select sum((value->>'target')::integer),count(distinct value->>'manufacturer') into v_total,v_brands from jsonb_array_elements(p_quotas);
  if v_total<>1000 or v_brands<>jsonb_array_length(p_quotas) then raise exception 'Launch requires unique brand quotas summing to 1000'; end if;
  select jsonb_build_object('publicActive',(select count(*) from public.vehicles where is_public and status='active'),
    'publicByBrand',(select jsonb_object_agg(manufacturer,n) from (select manufacturer,count(*) n from public.vehicles where is_public and status='active' group by manufacturer) b),
    'queue',(select jsonb_object_agg(status,n) from (select status,count(*) n from public.chestny_enrichment_queue group by status) q),
    'staging',(select jsonb_object_agg(enrichment_status,n) from (select enrichment_status,count(*) n from public.chestny_catalog_staging group by enrichment_status) s),
    'newPublicationsRule','Unique canonical IDs not known before baseline, explicitly attached to this launch, approved and still public; re-publication does not create a second credit; inactive credits do not count towards 1000') into v_counts;
  insert into public.chestny_catalog_launches(name,rules,baseline_counts) values(p_name,p_rules,v_counts) returning id into v_id;
  insert into public.chestny_catalog_launch_quotas(launch_id,manufacturer,target,baseline_public_count)
    select v_id,value->>'manufacturer',(value->>'target')::integer,
      coalesce((v_counts->'publicByBrand'->>(value->>'manufacturer'))::integer,0) from jsonb_array_elements(p_quotas);
  return v_id;
end; $$;
revoke all on function public.prepare_chestny_catalog_launch(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_chestny_catalog_launch(text,jsonb,jsonb) to service_role;


create or replace function public.finalize_chestny_catalog_baseline(p_launch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare expected bigint; actual bigint; baseline jsonb;
begin
  select baseline_counts into baseline from public.chestny_catalog_launches where id=p_launch and status='capturing' for update;
  if not found then raise exception 'Launch is not capturing'; end if;
  select count(*) into expected from public.vehicles where source_listing_id is not null;
  select count(distinct source_identifier) into actual from public.chestny_catalog_launch_baseline_identifiers where launch_id=p_launch;
  if actual<expected then raise exception 'Launch baseline is incomplete: captured %, vehicle IDs %',actual,expected; end if;
  update public.chestny_catalog_launches set status='prepared' where id=p_launch;
end; $$;
revoke all on function public.finalize_chestny_catalog_baseline(uuid) from public,anon,authenticated;
grant execute on function public.finalize_chestny_catalog_baseline(uuid) to service_role;
notify pgrst, 'reload schema';
commit;
