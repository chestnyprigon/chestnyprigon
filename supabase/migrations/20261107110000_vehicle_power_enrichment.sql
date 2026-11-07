-- Keep source-backed power components distinct for preliminary Korean-market enrichment.
alter table public.vehicles
  add column if not exists engine_power_ps numeric(8,2),
  add column if not exists engine_power_kw numeric(8,3),
  add column if not exists electric_motor_peak_kw numeric(8,3),
  add column if not exists electric_30min_kw numeric(8,3),
  add column if not exists system_combined_power_ps numeric(8,2),
  add column if not exists system_combined_power_kw numeric(8,3),
  add column if not exists power_basis text,
  add column if not exists power_source_type text,
  add column if not exists power_source_url text,
  add column if not exists power_confidence text,
  add column if not exists power_match_method text,
  add column if not exists power_checked_at timestamptz;

alter table public.vehicles
  add constraint vehicles_power_basis_check
    check (power_basis is null or power_basis in ('combustion_rated','combustion_rated_preliminary','electric_peak','electric_30min','system_combined','estimated_nearest_configuration','estimated_open_reference')),
  add constraint vehicles_power_confidence_check
    check (power_confidence is null or power_confidence in ('confirmed','probable','preliminary_exact_lot','preliminary_candidate','preliminary_configuration_match','preliminary_hybrid_engine_field','estimated','estimated_nearest_catalog_configuration','estimated_open_reference')),
  add constraint vehicles_power_values_positive_check
    check (
      (engine_power_ps is null or engine_power_ps > 0) and
      (engine_power_kw is null or engine_power_kw > 0) and
      (electric_motor_peak_kw is null or electric_motor_peak_kw > 0) and
      (electric_30min_kw is null or electric_30min_kw > 0) and
      (system_combined_power_ps is null or system_combined_power_ps > 0) and
      (system_combined_power_kw is null or system_combined_power_kw > 0)
    );

comment on column public.vehicles.engine_power_ps is 'Combustion engine rated power in metric PS; kept separate from electric motor and system output.';
comment on column public.vehicles.electric_motor_peak_kw is 'Peak electric motor power in kW; not interchangeable with 30-minute power.';
comment on column public.vehicles.electric_30min_kw is 'Continuous 30-minute electric power in kW, for TKS where required.';
comment on column public.vehicles.system_combined_power_ps is 'Combined system power in PS; not a substitute for combustion engine power in hybrid TKS calculations.';
comment on column public.vehicles.power_basis is 'Basis for the selected power field(s), including whether value is preliminary or estimated.';
comment on column public.vehicles.power_confidence is 'Evidence and match confidence; estimates remain explicitly marked.';
