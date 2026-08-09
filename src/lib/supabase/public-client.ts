import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

let browserClient: SupabaseClient<Database> | undefined;

function publicCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Chestny Prigon Supabase public credentials are not configured");
  return { url, key };
}

export function getSupabaseBrowserClient() {
  if (browserClient) return browserClient;
  const { url, key } = publicCredentials();
  browserClient = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return browserClient;
}

export function createSupabasePublicServerClient() {
  const { url, key } = publicCredentials();
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
