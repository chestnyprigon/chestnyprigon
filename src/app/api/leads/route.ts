import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import { sendLeadNotification } from "@/lib/telegram/leads";

const allowedSources = new Set(["homepage", "vehicle", "calculator", "callback", "website"]);

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const name = text(body.name, 120);
    const phone = text(body.phone, 40);
    const email = text(body.email, 160) || null;
    const message = text(body.message ?? body.car, 1000) || null;
    const source = allowedSources.has(text(body.source, 40)) ? text(body.source, 40) : "website";
    if (name.length < 2 || phone.length < 6) {
      return NextResponse.json({ error: "Укажите имя и корректный телефон" }, { status: 400 });
    }
    if (text(body.website, 100)) return NextResponse.json({ success: true });

    const supabase = createSupabaseAdminClient();
    const { data: lead, error } = await supabase.from("leads").insert({
      name,
      phone,
      email,
      message,
      source,
      page_url: text(body.pageUrl, 500) || null,
      referrer: text(body.referrer, 500) || null,
      utm_source: text(body.utmSource, 100) || null,
      utm_medium: text(body.utmMedium, 100) || null,
      utm_campaign: text(body.utmCampaign, 150) || null,
    }).select("id, public_number").single();
    if (error || !lead) throw error ?? new Error("Lead was not created");

    const vehicleId = text(body.vehicleId, 100);
    let vehicleSnapshot = body.vehicleSnapshot;
    if (vehicleId && !vehicleSnapshot) {
      const { data: vehicle } = await supabase.from("catalog_vehicles").select("id, manufacturer, model, generation, trim, model_year, mileage_km, price_usd, source_url, image_urls").eq("id", vehicleId).maybeSingle();
      vehicleSnapshot = vehicle;
    }
    if (vehicleId || vehicleSnapshot || body.calculationSnapshot) {
      await supabase.from("lead_vehicle_context").insert({
        lead_id: lead.id,
        vehicle_id: vehicleId || null,
        vehicle_snapshot: (vehicleSnapshot as never) ?? null,
        calculation_snapshot: (body.calculationSnapshot as never) ?? null,
      });
    }
    await supabase.from("lead_status_history").insert({ lead_id: lead.id, to_status: "new" });
    try {
      await sendLeadNotification({
        id: lead.id,
        publicNumber: lead.public_number,
        name,
        phone,
        message,
        source,
        pageUrl: text(body.pageUrl, 500) || null,
        vehicleSnapshot: body.vehicleSnapshot,
        calculationSnapshot: body.calculationSnapshot,
      });
      await supabase.from("leads").update({ notification_status: "sent" }).eq("id", lead.id);
    } catch (notificationError) {
      console.error("Lead Telegram notification failed", notificationError);
      await supabase.from("leads").update({ notification_status: "failed" }).eq("id", lead.id);
    }
    return NextResponse.json({ success: true, leadNumber: `CP-${lead.public_number}` }, { status: 201 });
  } catch (error) {
    console.error("Lead creation failed", error);
    return NextResponse.json({ error: "Не удалось отправить заявку. Попробуйте ещё раз." }, { status: 500 });
  }
}
