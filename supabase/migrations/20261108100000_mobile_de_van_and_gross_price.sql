-- Europe catalogue extension: retain original EU asking price and optional
-- source-reported Netto separately, and preserve the Master transport class.
-- Existing catalogue rows remain visible and keep their original price_amount.
BEGIN;

ALTER TABLE public.mobile_de_catalog_listings
  ADD COLUMN IF NOT EXISTS vehicle_class text NOT NULL DEFAULT 'CAR',
  ADD COLUMN IF NOT EXISTS source_price_basis text NOT NULL DEFAULT 'gross',
  ADD COLUMN IF NOT EXISTS source_price_source_path text NOT NULL DEFAULT 'price.grs.amount',
  ADD COLUMN IF NOT EXISTS net_price_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS net_price_source_path text,
  ADD COLUMN IF NOT EXISTS price_status text,
  ADD COLUMN IF NOT EXISTS net_price_observed_at timestamptz;

ALTER TABLE public.mobile_de_catalog_listings
  ADD CONSTRAINT mobile_de_vehicle_class_check
    CHECK (vehicle_class IN ('CAR','VAN')),
  ADD CONSTRAINT mobile_de_source_price_basis_check
    CHECK (source_price_basis IN ('gross','netto')),
  ADD CONSTRAINT mobile_de_source_net_price_check
    CHECK (net_price_amount IS NULL OR net_price_amount > 0),
  ADD CONSTRAINT mobile_de_source_net_price_provenance_check
    CHECK ((net_price_amount IS NULL AND net_price_source_path IS NULL AND price_status IS NULL AND net_price_observed_at IS NULL)
        OR (net_price_amount IS NOT NULL AND net_price_source_path = 'price.nt.amount' AND price_status = 'source_reported' AND net_price_observed_at IS NOT NULL));

CREATE OR REPLACE VIEW public.mobile_de_catalog_public_listings
WITH (security_barrier = true)
AS
SELECT master_id, source_id, title, make, model, production_year, first_registration,
       first_registration_precision, registration_year, mileage_km, engine_cc, power_ps,
       price_amount, price_currency, price_category, fuel_type, transmission, drive, body_type,
       color, description, options, source_url, primary_image_url, source_updated_at,
       last_seen_at, verified_at, updated_at,
       vehicle_class, source_price_basis, net_price_amount, net_price_source_path,
       price_status, net_price_observed_at, source_price_source_path
FROM public.mobile_de_catalog_listings
WHERE catalog_visible;

GRANT SELECT ON public.mobile_de_catalog_public_listings TO anon, authenticated, service_role;

COMMENT ON COLUMN public.mobile_de_catalog_listings.price_amount IS
  'Original source asking price in EUR; for Mobile.de records this is gross (Brutto). Never derive it from Netto.';
COMMENT ON COLUMN public.mobile_de_catalog_listings.source_price_source_path IS
  'Source-native field containing the original asking price; currently price.grs.amount for the Mobile.de collection.';
COMMENT ON COLUMN public.mobile_de_catalog_listings.net_price_amount IS
  'Optional Netto copied only from Master API evidence price.nt.amount; NULL means no source Netto is available.';
COMMENT ON COLUMN public.mobile_de_catalog_listings.vehicle_class IS
  'Transport class from Master DB; VAN is never inferred solely from a model name.';

COMMIT;
