export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      leads: {
        Row: {
          id: string;
          public_number: number;
          name: string;
          phone: string;
          email: string | null;
          telegram_username: string | null;
          message: string | null;
          source: string;
          page_url: string | null;
          referrer: string | null;
          utm_source: string | null;
          utm_medium: string | null;
          utm_campaign: string | null;
          status: string;
          assigned_to: string | null;
          assigned_telegram_id: string | null;
          assigned_telegram_name: string | null;
          notification_status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: { name: string; phone: string; email?: string | null; telegram_username?: string | null; message?: string | null; source?: string; page_url?: string | null; referrer?: string | null; utm_source?: string | null; utm_medium?: string | null; utm_campaign?: string | null; status?: string; assigned_telegram_id?: string | null; assigned_telegram_name?: string | null; notification_status?: string };
        Update: Partial<Database["public"]["Tables"]["leads"]["Insert"]>;
        Relationships: [];
      };
      lead_vehicle_context: {
        Row: { lead_id: string; vehicle_id: string | null; vehicle_snapshot: Json | null; calculation_snapshot: Json | null; created_at: string };
        Insert: { lead_id: string; vehicle_id?: string | null; vehicle_snapshot?: Json | null; calculation_snapshot?: Json | null };
        Update: Partial<Database["public"]["Tables"]["lead_vehicle_context"]["Insert"]>;
        Relationships: [];
      };
      lead_status_history: {
        Row: { id: number; lead_id: string; from_status: string | null; to_status: string; changed_by: string | null; comment: string | null; created_at: string };
        Insert: { lead_id: string; from_status?: string | null; to_status: string; changed_by?: string | null; comment?: string | null };
        Update: Partial<Database["public"]["Tables"]["lead_status_history"]["Insert"]>;
        Relationships: [];
      };
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
    Functions: {
      get_catalog_filter_options: {
        Args: { p_brand?: string | null; p_model?: string | null };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
