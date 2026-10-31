export type MobileDePrice = {
  amount: number | null;
  currency: string;
  type?: string | null;
};

export type MobileDePower = {
  value: number | null;
  unit?: string | null;
  label_ru?: string | null;
};

export type MobileDeRegistration = {
  value: string | null;
  precision?: string | null;
};

export type MobileDeImage = {
  url: string;
  position?: number | null;
  is_primary?: boolean;
  sort_order?: number | null;
};

export type MobileDeFreshness = {
  availability?: string | null;
  last_seen_at?: string | null;
  source_updated_at?: string | null;
  master_updated_at?: string | null;
  last_successful_source_check_at?: string | null;
};

export type MobileDeListing = {
  master_id: string;
  source: string;
  source_id: string;
  title: string;
  make: string | null;
  model: string | null;
  production_year: number | null;
  first_registration: MobileDeRegistration | null;
  mileage_km: number | null;
  engine_cc: number | null;
  power: MobileDePower | null;
  price: MobileDePrice | null;
  primary_image: MobileDeImage | null;
  freshness: MobileDeFreshness | null;
  fuel_type?: string | null;
  transmission?: string | null;
  drive?: string | null;
  body_type?: string | null;
  color?: string | null;
  description?: string | null;
  options?: Array<string | { name?: string | null; value?: string | null }> | null;
  gallery?: MobileDeImage[] | null;
};

export type MobileDeListingPage = {
  api_version?: string;
  data: MobileDeListing[];
  page: {
    limit: number;
    has_more: boolean;
    next_cursor: string | null;
  };
};

export type MobileDeFacets = {
  makes?: string[];
  models?: string[];
  fuel_types?: string[];
  transmissions?: string[];
  body_types?: string[];
  ranges?: {
    count?: number;
    [name: string]: unknown;
  };
};

export type MobileDeFilters = {
  make?: string;
  model?: string;
  fuel_type?: string;
  transmission?: string;
  body_type?: string;
  price_min?: string;
  price_max?: string;
  year_min?: string;
  year_max?: string;
  registration_year_min?: string;
  registration_year_max?: string;
  mileage_min?: string;
  mileage_max?: string;
  power_min?: string;
  power_max?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
};
