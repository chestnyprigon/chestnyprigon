import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export async function GET() {
  try {
    await requireAdmin();
    const { data, error } = await createSupabaseAdminClient().from("leads").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return NextResponse.json(data);
  } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
}
