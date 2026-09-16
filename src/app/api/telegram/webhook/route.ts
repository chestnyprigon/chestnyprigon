import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

type TelegramUpdate = { callback_query?: { id: string; data?: string; from?: { id: number; first_name?: string; last_name?: string; username?: string }; message?: { chat?: { id?: number }; message_id?: number } } };

async function telegram(token: string, method: string, body: Record<string, unknown>) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export async function POST(request: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const update = await request.json() as TelegramUpdate;
  const callback = update.callback_query;
  if (!callback?.data?.startsWith("lead:take:")) return NextResponse.json({ ok: true });
  const leadId = callback.data.slice("lead:take:".length);
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
  const { data: lead } = await supabase.from("leads").select("id, public_number, status, name, phone, message, source, page_url").eq("id", leadId).single();
  if (!lead) {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Заявка не найдена", show_alert: true });
    return NextResponse.json({ ok: true });
  }
  if (lead.status !== "new") {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Заявка уже взята в работу" });
    return NextResponse.json({ ok: true });
  }
  const { error } = await supabase.from("leads").update({ status: "in_progress", assigned_telegram_id: String(actor.id), assigned_telegram_name: actorName }).eq("id", leadId).eq("status", "new");
  if (error) return NextResponse.json({ error: "Could not update lead" }, { status: 500 });
  await supabase.from("lead_status_history").insert({ lead_id: leadId, from_status: "new", to_status: "in_progress", comment: `Взял в работу: ${actorName}` });
  await telegram(token, "sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID, message_thread_id: Number(process.env.TELEGRAM_TOPIC_WORK ?? "3"), text: `🟡 Заявка #CP-${lead.public_number}\n\nИмя: ${lead.name}\nТелефон: ${lead.phone}\nКомментарий: ${lead.message ?? "—"}\n\nОтветственный: ${actorName}\nСтатус: В работе`, disable_web_page_preview: true });
  if (callback.message?.chat?.id && callback.message.message_id) await telegram(token, "deleteMessage", { chat_id: callback.message.chat.id, message_id: callback.message.message_id });
  await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Заявка закреплена за вами" });
  if (callback.message?.chat?.id && callback.message.message_id) {
    await telegram(token, "editMessageReplyMarkup", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [[{ text: `🟡 В работе: ${actorName}`, callback_data: `lead:take:${leadId}` }]] } });
  }
  return NextResponse.json({ ok: true });
}
