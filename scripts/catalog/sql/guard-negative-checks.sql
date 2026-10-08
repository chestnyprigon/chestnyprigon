
do $$ declare v public.vehicles; other_id uuid; begin
  select * into v from public.vehicles where source_listing_id='41544328';
  update public.vehicles set is_public=false where id=v.id;
  begin
    update public.vehicles set is_public=true where id=v.id;
    raise exception 'TEST FAILED: unverified publication accepted';
  exception when others then
    if sqlerrm not like '%requires a current integrity gate%' then raise; end if;
  end;
  select id into other_id from public.vehicles where id<>v.id limit 1;
  begin
    update public.vehicle_source_identifiers set vehicle_id=other_id where vehicle_id=v.id;
    raise exception 'TEST FAILED: identifier reassignment accepted';
  exception when others then
    if sqlerrm not like '%identity_source_identifier_collision%' then raise; end if;
  end;
  begin
    update public.listing_screening set decision='manual_review' where source_listing_id=v.source_listing_id;
    raise exception 'TEST FAILED: manual_review accepted';
  exception when check_violation then null;
  end;
  begin
    update public.listing_screening set decision='isolated',rules_version='2026-10-07.1',details='{}' where source_listing_id=v.source_listing_id;
    raise exception 'TEST FAILED: empty evidence accepted';
  exception when others then
    if sqlerrm not like '%requires decision evidence%' then raise; end if;
  end;
  update public.listing_screening set decision='isolated', rules_version='rollback-test' where source_listing_id='41839536';
  if exists(select 1 from public.vehicles where source_listing_id='41839536' and is_public) then raise exception 'TEST FAILED: decision downgrade remains public'; end if;
end; $$;
select 'publication, identity, decision and evidence guards passed; transaction will be rolled back' as checkpoint;
