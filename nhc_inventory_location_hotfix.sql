-- NHC Pharmacy POS v3.18.2 — Inventory location hotfix
-- Run once in the SQL Editor of the dedicated NHC Supabase project.
-- Safe to re-run: it inserts only when the required rows are missing.

begin;

do $$
begin
  if to_regclass('public.locations') is null
     or to_regclass('public.alerts_config') is null then
    raise exception
      'NHC base schema is missing. Apply nhc_pharmacy_migration_v1_pharmacy_only.sql first.';
  end if;
end
$$;

insert into public.locations (name, type)
select 'NHC Pharmacy Counter', 'pharmacy_counter'
where not exists (select 1 from public.locations where type = 'pharmacy_counter');

insert into public.alerts_config (location_id, low_stock_threshold, expiry_alert_days)
select l.id, 200, 90
from public.locations l
where l.type = 'pharmacy_counter'
  and not exists (select 1 from public.alerts_config a where a.location_id = l.id);

commit;

select id, name, type
from public.locations
where type = 'pharmacy_counter';
