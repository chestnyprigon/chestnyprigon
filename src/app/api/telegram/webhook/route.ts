import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

type TelegramUpdate = { callback_query?: { id: string; data?: string; from?: { id: number; first_name?: string; last_name?: string; username?: string }; message?: { chat?: { id?: number }; message_id?: number } } };

async function telegram(token: string, method: string, body: Record<string, unknown>) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function snapshotLines(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const item = snapshot as Record<string, unknown>;
  return [
    `Автомобиль: ${[item.brand, item.model].filter(Boolean).join(" ") || "—"}`,
    item.trim ? `Комплектация: ${String(item.trim)}` : "",
    item.year ? `Год: ${String(item.year)}` : "",
    item.mileage ? `Пробег: ${String(item.mileage)} км` : "",
    item.sourceUrl ? `Объявление: ${String(item.sourceUrl)}` : "",
  ].filter(Boolean);
}

function calculationLines(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const item = snapshot as Record<string, unknown>;
  return [
    item.totalUsd ? `Предварительно под ключ: $${String(item.totalUsd)}` : "",
    item.preferential !== undefined ? `Льготная растаможка: ${item.preferential ? "включена" : "не включена"}` : "",
  ].filter(Boolean);
}

export async function POST(request: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const update = await request.json() as TelegramUpdate;
  const callback = update.callback_query;
  if (!callback?.data?.startsWith("lead:")) return NextResponse.json({ ok: true });
  const action = callback.data.split(":")[1];
  if (action !== "take" && action !== "contact") return NextResponse.json({ ok: true });
  const leadId = callback.data.slice(`lead:${action}:`.length);
  const actor = callback.from;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !actor) return NextResponse.json({ error: "Telegram is not configured" }, { status: 500 });
  const allowed = (process.env.TELEGRAM_MANAGER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!allowed.includes(String(actor.id))) {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "У вас нет доступа к управлению заявками", show_alert: true });
    return NextResponse.json({ ok: true });
  }

  const supabase = createSupabaseAdminClient();
  const actorName = [actor.first_name, actor.last_name].filter(Boolean).join(" ") || actor.username || String(actor.id);
  const { data: lead } = await supabase.from("leads").select("id, public_number, status, name, phone, message, source, page_url, assigned_telegram_name").eq("id", leadId).single();
  if (!lead) {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Заявка не найдена", show_alert: true });
    return NextResponse.json({ ok: true });
  }
  if (action === "take" && lead.status !== "new") {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Заявка уже взята в работу" });
    return NextResponse.json({ ok: true });
  }
  if (action === "contact" && lead.status !== "in_progress") {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Заявка уже не находится в работе" });
    return NextResponse.json({ ok: true });
  }
  const { data: context } = await supabase.from("lead_vehicle_context").select("vehicle_snapshot, calculation_snapshot").eq("lead_id", leadId).maybeSingle();
  const nextStatus = action === "take" ? "in_progress" : "contacted";
  const expectedStatus = action === "take" ? "new" : "in_progress";
  const leadUpdate = action === "take" ? { status: nextStatus, assigned_telegram_id: String(actor.id), assigned_telegram_name: actorName } : { status: nextStatus };
  const { error } = await supabase.from("leads").update(leadUpdate).eq("id", leadId).eq("status", expectedStatus);
  if (error) return NextResponse.json({ error: "Could not update lead" }, { status: 500 });
  await supabase.from("lead_status_history").insert({ lead_id: leadId, from_status: expectedStatus, to_status: nextStatus, comment: action === "take" ? `Взял в работу: ${actorName}` : `Связались: ${actorName}` });
  const destination = action === "take" ? process.env.TELEGRAM_TOPIC_WORK : process.env.TELEGRAM_TOPIC_CONTACTED;
  const statusLabel = action === "take" ? "В работе" : "Связались";
  const nextButton = action === "take" ? { text: "🔵 Связались", callback_data: `lead:contact:${leadId}` } : null;
  const vehicle = snapshotLines(context?.vehicle_snapshot);
  const calculation = calculationLines(context?.calculation_snapshot);
  const details = [...vehicle, ...(calculation.length ? ["", "Расчёт", ...calculation] : [])].join("\n");
  await telegram(token, "sendMessage", { chat_id: process.env.TELEGRAM_GROUP_ID ?? process.env.TELEGRAM_CHAT_ID, message_thread_id: Number(destination), text: `${action === "take" ? "🟡" : "🔵"} Заявка #CP-${lead.public_number}\n\nИмя: ${lead.name}\nТелефон: ${lead.phone}\nКомментарий: ${lead.message ?? "—"}${details ? `\n\n${details}` : ""}\n\nОтветственный: ${action === "take" ? actorName : (lead.assigned_telegram_name ?? actorName)}\nСтатус: ${statusLabel}`, disable_web_page_preview: true, reply_markup: { inline_keyboard: nextButton ? [[nextButton]] : [] } });
  if (callback.message?.chat?.id && callback.message.message_id) await telegram(token, "deleteMessage", { chat_id: callback.message.chat.id, message_id: callback.message.message_id });
  await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: action === "take" ? "Заявка закреплена за вами" : "Статус изменён: связались" });
  if (callback.message?.chat?.id && callback.message.message_id) {
    await telegram(token, "editMessageReplyMarkup", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [[{ text: `🟡 В работе: ${actorName}`, callback_data: `lead:take:${leadId}` }]] } });
  }
  return NextResponse.json({ ok: true });
}
