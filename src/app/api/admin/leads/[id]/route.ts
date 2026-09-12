import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

const statuses = new Set(["new", "in_progress", "contacted", "quote_sent", "waiting", "won", "lost"]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await params;
    const { status } = await request.json() as { status?: string };
    const nextStatus = status ?? "";
    if (!statuses.has(nextStatus)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    const db = createSupabaseAdminClient();
    const { data: current, error: findError } = await db.from("leads").select("status").eq("id", id).single();
    if (findError) throw findError;
    const { error } = await db.from("leads").update({ status: nextStatus }).eq("id", id);
    if (error) throw error;
    await db.from("lead_status_history").insert({ lead_id: id, from_status: current.status, to_status: nextStatus, comment: "Статус изменён из админки" });
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
}
