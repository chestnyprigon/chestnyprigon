import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await params;
    const body = String((await request.json() as { body?: string }).body ?? "").trim().slice(0, 2000);
    if (!body) return NextResponse.json({ error: "Комментарий пуст" }, { status: 400 });
    const { error } = await createSupabaseAdminClient().from("lead_comments").insert({ lead_id: id, body });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
}
