import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";

type TelegramActor = { id: number; first_name?: string; last_name?: string; username?: string };
type TelegramMessage = { message_id: number; text?: string; from?: TelegramActor; chat?: { id?: number; type?: string } };
type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: { id: string; data?: string; from?: TelegramActor; message?: TelegramMessage };
};

async function telegram(token: string, method: string, body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
  return response;
}

function catalogOwnerId() {
  const raw = process.env.TELEGRAM_CATALOG_OWNER_ID?.trim();
  return raw && /^\d{5,15}$/.test(raw) ? raw : null;
}

function catalogDatabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Catalog Telegram Supabase credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function currentCatalogRun(db: ReturnType<typeof catalogDatabase>) {
  const active = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,pause_reason")
    .in("status", ["approved", "running", "paused"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (active.error) throw new Error(`Не удалось прочитать активный run: ${active.error.message}`);
  if (active.data) return active.data;
  const latest = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,pause_reason")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw new Error(`Не удалось прочитать последний run: ${latest.error.message}`);
  return latest.data;
}

async function queueCounts(db: ReturnType<typeof catalogDatabase>, runId: string) {
  const statuses = ["queued", "leased", "succeeded", "unavailable", "failed", "cancelled"];
  const results = await Promise.all(statuses.map(async (status) => {
    const { count, error } = await db.from("chestny_enrichment_queue").select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", status);
    if (error) throw new Error(`Не удалось прочитать очередь (${status}): ${error.message}`);
    return [status, count ?? 0] as const;
  }));
  return Object.fromEntries(results);
}

async function ownerMessage(token: string, chatId: number, text: string, replyMarkup?: Record<string, unknown>) {
  await telegram(token, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

async function enqueueCatalogCommand(input: { updateId: number; actorId: number; chatId: number; command: "start" | "pause" | "stop" | "resume"; runId: string; maxItems?: number }) {
  const db = catalogDatabase();
  const { error } = await db.from("chestny_catalog_worker_commands").insert({
    telegram_update_id: input.updateId,
    telegram_user_id: input.actorId,
    telegram_chat_id: input.chatId,
    command: input.command,
    run_id: input.runId,
    max_items: input.maxItems ?? 50,
  });
  if (error && !/duplicate key|unique constraint/i.test(error.message)) throw new Error(`Не удалось поставить команду в очередь: ${error.message}`);
}

async function handleCatalogMessage(update: TelegramUpdate, token: string) {
  const message = update.message;
  const ownerId = catalogOwnerId();
  const actor = message?.from;
  const chatId = message?.chat?.id;
  const commandText = message?.text?.trim().split(/\s+/, 1)[0]?.replace(/@[^@]+$/, "").toLowerCase();
  if (!message || !actor || !chatId || (!commandText?.startsWith("/catalog") && commandText !== "/start")) return NextResponse.json({ ok: true });
  if (!ownerId || String(actor.id) !== ownerId || message.chat?.type !== "private" || String(chatId) !== ownerId) return NextResponse.json({ ok: true });
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) return NextResponse.json({ error: "Webhook secret is not configured" }, { status: 503 });
  const db = catalogDatabase();

  if (commandText === "/start" || commandText === "/catalog" || commandText === "/catalog_help") {
    await ownerMessage(token, chatId, "Пульт каталога:\n/catalog_status — состояние run и очереди\n/catalog_plan — остатки квот по маркам\n/catalog_report — сводка обработки\n/catalog_start — запросить запуск до 50 кандидатов\n/catalog_pause — пауза после текущей карточки\n/catalog_resume — продолжить paused run\n/catalog_stop — отменить run\n/catalog_publish — публикация закрыта до прохождения пилота");
    return NextResponse.json({ ok: true });
  }

  if (commandText === "/catalog_status" || commandText === "/catalog_report") {
    const run = await currentCatalogRun(db);
    if (!run) { await ownerMessage(token, chatId, "Run каталога пока не найден."); return NextResponse.json({ ok: true }); }
    const counts = await queueCounts(db, run.id);
    const processed = Number(counts.succeeded) + Number(counts.unavailable) + Number(counts.failed) + Number(counts.cancelled);
    const report = `Каталог\nRun: ${run.id}\nСтатус: ${run.status}\nКандидатов: ${run.candidate_count}\nВ очереди: ${counts.queued}; leased: ${counts.leased}\nОбработано: ${processed}/50\nУспешно: ${counts.succeeded}; недоступно: ${counts.unavailable}; ошибок: ${counts.failed}; отменено: ${counts.cancelled}${run.pause_reason ? `\nПричина паузы: ${JSON.stringify(run.pause_reason).slice(0, 500)}` : ""}`;
    await ownerMessage(token, chatId, report);
    return NextResponse.json({ ok: true });
  }

  if (commandText === "/catalog_plan") {
    const { data: launch, error: launchError } = await db.from("chestny_catalog_launches").select("id,status,name").eq("name", "local-catalog-1000-20261007").single();
    if (launchError) throw new Error(`Не удалось прочитать план запуска: ${launchError.message}`);
    const { data: brands, error } = await db.from("chestny_catalog_brand_search_status")
      .select("manufacturer,target,published_count,remaining_quota,candidate_backlog,search_offset,status")
      .eq("launch_id", launch.id).order("manufacturer");
    if (error) throw new Error(`Не удалось прочитать квоты: ${error.message}`);
    const lines = (brands ?? []).map((brand: Record<string, unknown>) => `${brand.manufacturer}: ${brand.published_count}/${brand.target}, осталось ${brand.remaining_quota}, кандидатов ${brand.candidate_backlog}, offset ${brand.search_offset} (${brand.status})`);
    await ownerMessage(token, chatId, `План ${launch.name} (${launch.status})\n${lines.join("\n")}`.slice(0, 3900));
    return NextResponse.json({ ok: true });
  }

  if (commandText === "/catalog_publish") {
    await ownerMessage(token, chatId, "Публикация сейчас недоступна. Она откроется только после проверки отчёта пилота и отдельного подтверждения.");
    return NextResponse.json({ ok: true });
  }

  const run = await currentCatalogRun(db);
  if (!run) { await ownerMessage(token, chatId, "Run каталога не найден."); return NextResponse.json({ ok: true }); }
  const updateId = update.update_id;
  if (!Number.isSafeInteger(updateId)) return NextResponse.json({ error: "Telegram update_id is missing" }, { status: 400 });

  if (commandText === "/catalog_start" || commandText === "/catalog_resume" || commandText === "/catalog_stop") {
    const command = commandText === "/catalog_start" ? "start" : commandText === "/catalog_resume" ? "resume" : "stop";
    const counts = await queueCounts(db, run.id);
    const callbackData = `catalog:confirm:${command}:${run.id}:50`;
    const prompt = command === "start"
      ? `Подтверди запуск run ${run.id}: максимум 50 кандидатов, одна карточка за раз, прямой Encar, пауза 10 секунд. Публикация выключена.`
      : command === "resume" ? `Подтверди продолжение paused run ${run.id}, максимум 50 обработанных кандидатов за запуск.`
        : `Подтверди отмену run ${run.id}. В очереди ${counts.queued}, leased ${counts.leased}; queued будут отменены, текущая карточка завершится.`;
    await ownerMessage(token, chatId, prompt, { inline_keyboard: [[{ text: command === "stop" ? "Подтвердить отмену" : "Подтвердить", callback_data: callbackData }]] });
    return NextResponse.json({ ok: true });
  }

  if (commandText === "/catalog_pause") {
    await enqueueCatalogCommand({ updateId: updateId!, actorId: actor.id, chatId, command: "pause", runId: run.id });
    await ownerMessage(token, chatId, `Пауза поставлена в очередь для run ${run.id}; worker остановится после текущей карточки.`);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: true });
}

async function handleCatalogCallback(update: TelegramUpdate, token: string) {
  const callback = update.callback_query;
  const ownerId = catalogOwnerId();
  const actor = callback?.from;
  const chatId = callback?.message?.chat?.id;
  const data = callback?.data?.split(":") ?? [];
  if (!callback || data.length !== 5 || data[0] !== "catalog" || data[1] !== "confirm") return NextResponse.json({ ok: true });
  if (!ownerId || !actor || String(actor.id) !== ownerId || callback.message?.chat?.type !== "private" || String(chatId) !== ownerId) {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа", show_alert: true });
    return NextResponse.json({ ok: true });
  }
  const [, , command, runId, itemLimit] = data;
  if (!(command === "start" || command === "resume" || command === "stop") || !/^[0-9a-f-]{36}$/i.test(runId) || itemLimit !== "50") {
    await telegram(token, "answerCallbackQuery", { callback_query_id: callback.id, text: "Некорректная команда", show_alert: true });
    return NextResponse.json({ ok: true });
  }
  const tokenValue = process.env.TELEGRAM_BOT_TOKEN;
  const updateId = update.update_id;
  if (!tokenValue || !Number.isSafeInteger(updateId) || !chatId) return NextResponse.json({ error: "Telegram command context is incomplete" }, { status: 500 });
  const db = catalogDatabase();
  const { data: run, error } = await db.from("chestny_enrichment_runs").select("status").eq("id", runId).single();
  if (error || !run) {
    await telegram(tokenValue, "answerCallbackQuery", { callback_query_id: callback.id, text: "Run не найден", show_alert: true });
    return NextResponse.json({ ok: true });
  }
  const expected = command === "start" ? "approved" : command === "resume" ? "paused" : ["approved", "running", "paused"];
  if (Array.isArray(expected) ? !expected.includes(run.status) : run.status !== expected) {
    await telegram(tokenValue, "answerCallbackQuery", { callback_query_id: callback.id, text: `Run уже в статусе ${run.status}`, show_alert: true });
    return NextResponse.json({ ok: true });
  }
  await enqueueCatalogCommand({ updateId: updateId!, actorId: actor.id, chatId, command, runId, maxItems: 50 });
  await telegram(tokenValue, "answerCallbackQuery", { callback_query_id: callback.id, text: "Команда передана Mac mini" });
  await ownerMessage(tokenValue, chatId, `Команда ${command} для run ${runId} принята; Mac mini применит её в ближайшем цикле.`);
  return NextResponse.json({ ok: true });
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
  const update = await request.json() as TelegramUpdate;
  const callback = update.callback_query;
  const catalogUpdate = Boolean(update.message?.text?.trim().split(/\s+/, 1)[0]?.startsWith("/catalog")
    || update.message?.text?.trim().split(/\s+/, 1)[0] === "/start"
    || callback?.data?.startsWith("catalog:"));
  if (catalogUpdate) {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return NextResponse.json({ error: "Telegram is not configured" }, { status: 503 });
    if (callback?.data?.startsWith("catalog:")) return handleCatalogCallback(update, token);
    return handleCatalogMessage(update, token);
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
