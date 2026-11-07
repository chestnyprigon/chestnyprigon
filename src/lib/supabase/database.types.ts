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
          utm_content: string | null;
          utm_term: string | null;
          status: string;
          assigned_to: string | null;
          assigned_telegram_id: string | null;
          assigned_telegram_name: string | null;
          notification_status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: { name: string; phone: string; email?: string | null; telegram_username?: string | null; message?: string | null; source?: string; page_url?: string | null; referrer?: string | null; utm_source?: string | null; utm_medium?: string | null; utm_campaign?: string | null; utm_content?: string | null; utm_term?: string | null; status?: string; assigned_telegram_id?: string | null; assigned_telegram_name?: string | null; notification_status?: string };
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
      lead_comments: {
        Row: { id: number; lead_id: string; author_name: string; body: string; created_at: string };
        Insert: { lead_id: string; author_name?: string; body: string };
        Update: Partial<Database["public"]["Tables"]["lead_comments"]["Insert"]>;
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
          engine_power_ps: number | null;
          engine_power_kw: number | null;
          electric_motor_peak_kw: number | null;
          electric_30min_kw: number | null;
          system_combined_power_ps: number | null;
          system_combined_power_kw: number | null;
          power_basis: string | null;
          power_source_type: string | null;
          power_source_url: string | null;
          power_confidence: string | null;
          power_match_method: string | null;
          power_checked_at: string | null;
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
      mobile_de_catalog_listings: {
        Row: {
          master_id: string; source_id: string; title: string; make: string; model: string | null;
          production_year: number | null; first_registration: string; first_registration_precision: string;
          registration_year: number; mileage_km: number; engine_cc: number | null; power_ps: number;
          price_amount: number; price_currency: string; price_category: string; fuel_type: string | null;
          transmission: string | null; drive: string | null; body_type: string | null; color: string | null;
          description: string | null; options: Json; source_url: string; primary_image_url: string | null;
          source_status: string; proof_status: string; is_new_vehicle: boolean; catalog_visible: boolean;
          source_updated_at: string | null; last_seen_at: string | null; verified_at: string | null;
          source_payload: Json; imported_at: string; updated_at: string;
        };
        Insert: {
          master_id: string; source_id: string; title: string; make: string; model?: string | null;
          production_year?: number | null; first_registration: string; first_registration_precision: string;
          registration_year: number; mileage_km: number; engine_cc?: number | null; power_ps: number;
          price_amount: number; price_currency?: string; price_category: string; fuel_type?: string | null;
          transmission?: string | null; drive?: string | null; body_type?: string | null; color?: string | null;
          description?: string | null; options?: Json; source_url: string; primary_image_url?: string | null;
          source_status: string; proof_status: string; is_new_vehicle?: boolean; catalog_visible?: boolean;
          source_updated_at?: string | null; last_seen_at?: string | null; verified_at?: string | null;
          source_payload?: Json; imported_at?: string; updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["mobile_de_catalog_listings"]["Insert"]>;
        Relationships: [];
      };
      mobile_de_catalog_images: {
        Row: { id: number; master_id: string; source_url: string; position: number; is_primary: boolean; created_at: string };
        Insert: { master_id: string; source_url: string; position: number; is_primary?: boolean; created_at?: string };
        Update: Partial<Database["public"]["Tables"]["mobile_de_catalog_images"]["Insert"]>;
        Relationships: [{ foreignKeyName: "mobile_de_catalog_images_master_id_fkey"; columns: ["master_id"]; isOneToOne: false; referencedRelation: "mobile_de_catalog_listings"; referencedColumns: ["master_id"] }];
      };
      mobile_de_catalog_import_runs: {
        Row: { id: string; status: string; source_candidate_count: number; fetched_count: number; proven_count: number; rejected_count: number; upserted_count: number; cursor: string | null; error_summary: Json; started_at: string; finished_at: string | null };
        Insert: { status?: string; source_candidate_count?: number; fetched_count?: number; proven_count?: number; rejected_count?: number; upserted_count?: number; cursor?: string | null; error_summary?: Json; started_at?: string; finished_at?: string | null };
        Update: Partial<Database["public"]["Tables"]["mobile_de_catalog_import_runs"]["Insert"]>;
        Relationships: [];
      };
      russia_price_snapshots: {
        Row: {
          source: "korea" | "europe";
          listing_id: string;
          destination: "RU";
          status: "pending" | "ready" | "stale" | "failed";
          revision: number;
          calculation: Json | null;
          calculated_at: string | null;
          last_attempt_at: string | null;
          next_refresh_at: string;
          last_error_code: string | null;
          updated_at: string;
        };
        Insert: {
          source: "korea" | "europe";
          listing_id: string;
          destination?: "RU";
          status?: "pending" | "ready" | "stale" | "failed";
          revision?: number;
          calculation?: Json | null;
          calculated_at?: string | null;
          last_attempt_at?: string | null;
          next_refresh_at?: string;
          last_error_code?: string | null;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["russia_price_snapshots"]["Insert"]>;
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
      mobile_de_catalog_public_listings: {
        Row: {
          master_id: string; source_id: string; title: string; make: string; model: string | null;
          production_year: number | null; first_registration: string; first_registration_precision: string;
          registration_year: number; mileage_km: number; engine_cc: number | null; power_ps: number;
          price_amount: number; price_currency: string; price_category: string; fuel_type: string | null;
          transmission: string | null; drive: string | null; body_type: string | null; color: string | null;
          description: string | null; options: Json; source_url: string; primary_image_url: string | null;
          source_updated_at: string | null; last_seen_at: string | null; verified_at: string | null; updated_at: string;
        };
        Relationships: [];
      };
      mobile_de_catalog_public_images: {
        Row: { master_id: string; source_url: string; position: number; is_primary: boolean };
        Relationships: [];
      };
    };
    Functions: {
      get_catalog_filter_options: {
        Args: { p_brand?: string | null; p_model?: string | null };
        Returns: Json;
      };
      get_mobile_de_catalog_facets: {
        Args: { p_make?: string | null };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
