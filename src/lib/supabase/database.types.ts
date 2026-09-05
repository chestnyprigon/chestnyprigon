export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      vehicle_source_identifiers: {
        Row: {
          source_identifier: string;
          vehicle_id: string;
          identifier_type: string;
          first_seen_at: string;
          last_seen_at: string;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      vehicles: {
        Row: {
          id: string;
          source_listing_id: string;
          manufacturer: string;
          model: string;
          generation: string | null;
          trim: string | null;
          model_year: number;
          first_registration_date: string | null;
          mileage_km: number;
          price_krw: number;
          price_usd: number | null;
          engine_cc: number | null;
          fuel_type: string;
          transmission: string | null;
          drive_type: string | null;
          body_type: string | null;
          exterior_color: string | null;
          location: string | null;
          vin_masked: string | null;
          source_url: string;
          status: string;
          is_public: boolean;
          published_at: string | null;
          source_updated_at: string | null;
          last_seen_at: string;
          last_checked_at: string | null;
          revalidation_miss_count: number;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      vehicle_images: {
        Row: { id: number; vehicle_id: string; source_url: string; storage_path: string | null; position: number };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      vehicle_reports: {
        Row: {
          vehicle_id: string;
          canonical_vehicle_id: string;
          options: Json;
          inspection_summary: Json;
          accident_summary: Json;
          report_status: string;
          fetched_at: string;
          updated_at: string;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      pricing_profiles: {
        Row: { id: string; version: string; krw_per_usd: number; delivery_usd: number; commission_rate: number; svh_declarant_eur: number; customs_clearance_eur: number; utilization_fee_eur: number; company_service_usd: number; updated_at: string };
        Insert: { id: string; version: string; krw_per_usd: number; delivery_usd: number; commission_rate: number; svh_declarant_eur: number; customs_clearance_eur: number; utilization_fee_eur: number; company_service_usd: number; updated_at?: string };
        Update: Partial<{ version: string; krw_per_usd: number; delivery_usd: number; commission_rate: number; svh_declarant_eur: number; customs_clearance_eur: number; utilization_fee_eur: number; company_service_usd: number; updated_at: string }>;
        Relationships: [];
      };
      pricing_exchange_rates: {
        Row: { id: string; rate_date: string; usd_byn: number; eur_byn: number; source_url: string; fetched_at: string; updated_at: string };
        Insert: { id: string; rate_date: string; usd_byn: number; eur_byn: number; source_url: string; fetched_at?: string; updated_at?: string };
        Update: Partial<{ rate_date: string; usd_byn: number; eur_byn: number; source_url: string; fetched_at: string; updated_at: string }>;
        Relationships: [];
      };
      pricing_krw_usdt_rates: {
        Row: { id: string; raw_krw_per_usdt: number; adjustment_krw: number; effective_krw_per_usd: number; source_url: string; source_as_of: string | null; fetched_at: string; updated_at: string };
        Insert: { id: string; raw_krw_per_usdt: number; adjustment_krw: number; effective_krw_per_usd: number; source_url: string; source_as_of?: string | null; fetched_at: string; updated_at?: string };
        Update: Partial<{ raw_krw_per_usdt: number; adjustment_krw: number; effective_krw_per_usd: number; source_url: string; source_as_of: string | null; fetched_at: string; updated_at: string }>;
        Relationships: [];
      };
    };
    Views: {
      catalog_vehicles: {
        Row: {
          id: string | null;
          source_listing_id: string | null;
          manufacturer: string | null;
          model: string | null;
          generation: string | null;
          trim: string | null;
          model_year: number | null;
          first_registration_date: string | null;
          mileage_km: number | null;
          price_krw: number | null;
          price_usd: number | null;
          engine_cc: number | null;
          fuel_type: string | null;
          transmission: string | null;
          drive_type: string | null;
          body_type: string | null;
          exterior_color: string | null;
          location: string | null;
          vin_masked: string | null;
          source_url: string | null;
          source_updated_at: string | null;
          published_at: string | null;
          last_seen_at: string | null;
          last_checked_at: string | null;
          revalidation_miss_count: number;
          image_urls: string[] | null;
          report_options: Json | null;
          inspection_summary: Json | null;
          accident_summary: Json | null;
          report_status: string | null;
          report_fetched_at: string | null;
        };
        Relationships: [];
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
