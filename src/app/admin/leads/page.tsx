import { redirect } from "next/navigation";
import { LeadsDashboard } from "@/components/admin/LeadsDashboard";
import { isAdmin } from "@/lib/admin/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export default async function LeadsPage() {
  if (!await isAdmin()) redirect("/admin/login");
  const db = createSupabaseAdminClient();
  const [{ data: leads }, { data: comments }] = await Promise.all([db.from("leads").select("id, public_number, name, phone, message, source, status, assigned_telegram_name, created_at").order("created_at", { ascending: false }).limit(100), db.from("lead_comments").select("id, lead_id, author_name, body, created_at").order("created_at")]);
  return <LeadsDashboard leads={leads ?? []} comments={comments ?? []} />;
}
