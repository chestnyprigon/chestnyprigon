import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type TelegramActor = { id: number };
type TelegramChat = { id?: number; type?: string };
type TelegramMessage = { text?: string; from?: TelegramActor; chat?: TelegramChat };
type TelegramCallback = {
  id: string;
  data?: string;
  from?: TelegramActor;
  message?: TelegramMessage;
};
type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
};

type Run = {
  id: string;
  status: string;
  candidate_count: number;
  created_at: string;
  pause_reason: unknown;
};

function apiResponse(method: string, params: Record<string, unknown>) {
  return NextResponse.json({ method, ...params });
}

function isValidSecret(received: string | null, expected: string | undefined) {
  if (!received || !expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

function ownerId() {
  const value = process.env.TELEGRAM_CATALOG_OWNER_ID?.trim();
  return value && /^\d{5,15}$/.test(value) ? value : null;
}

function database() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Catalog Telegram Supabase credentials are not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function currentRun(db: ReturnType<typeof database>) {
  const active = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,pause_reason")
    .in("status", ["approved", "running", "paused"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (active.error) throw new Error("Could not read active catalog run");
  if (active.data) return active.data as Run;

  const latest = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,pause_reason")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw new Error("Could not read latest catalog run");
  return latest.data as Run | null;
}

async function queueCounts(db: ReturnType<typeof database>, runId: string) {
  const statuses = ["queued", "leased", "succeeded", "unavailable", "failed", "cancelled"];
  const entries = await Promise.all(statuses.map(async (status) => {
    const { count, error } = await db.from("chestny_enrichment_queue")
      .select("id", { count: "exact", head: true }).eq("run_id", runId).eq("status", status);
    if (error) throw new Error("Could not read catalog queue");
    return [status, count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<string, number>;
}

async function enqueue(input: {
  updateId: number;
  actorId: number;
  chatId: number;
  command: "start" | "pause" | "stop" | "resume";
  runId: string;
}) {
  const { error } = await database().from("chestny_catalog_worker_commands").insert({
    telegram_update_id: input.updateId,
    telegram_user_id: input.actorId,
    telegram_chat_id: input.chatId,
    command: input.command,
    run_id: input.runId,
    max_items: 50,
  });
  if (error && !/duplicate key|unique constraint/i.test(error.message)) {
    throw new Error("Could not queue catalog command");
  }
}

function privateOwnerMessage(update: TelegramUpdate) {
  const owner = ownerId();
  const message = update.message;
  const actor = message?.from;
  const chatId = message?.chat?.id;
  return Boolean(owner && message && actor && chatId && String(actor.id) === owner
    && message.chat?.type === "private" && String(chatId) === owner);
}

function noOp() {
  return NextResponse.json({ ok: true });
}

async function handleMessage(update: TelegramUpdate) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const actor = message?.from;
  const command = message?.text?.trim().split(/\s+/, 1)[0]?.replace(/@[^@]+$/, "").toLowerCase();
  if (!privateOwnerMessage(update) || !message || !chatId || !actor) return noOp();

  if (command === "/start" || command === "/catalog" || command === "/catalog_help") {
    return apiResponse("sendMessage", {
      chat_id: chatId,
      disable_web_page_preview: true,
      text: "Пульт каталога:\n/catalog_status — состояние run и очереди\n/catalog_plan — остатки квот по маркам\n/catalog_report — сводка обработки\n/catalog_start — запросить запуск до 50 кандидатов\n/catalog_pause — пауза после текущей карточки\n/catalog_resume — продолжить paused run\n/catalog_stop — отменить run\n/catalog_publish — публикация закрыта до прохождения пилота",
    });
  }

  if (command === "/catalog_status" || command === "/catalog_report") {
    const db = database();
    const run = await currentRun(db);
    if (!run) return apiResponse("sendMessage", { chat_id: chatId, text: "Run каталога пока не найден." });
    const counts = await queueCounts(db, run.id);
    const processed = counts.succeeded + counts.unavailable + counts.failed + counts.cancelled;
    const pause = run.pause_reason ? `\nПричина паузы: ${JSON.stringify(run.pause_reason).slice(0, 500)}` : "";
    return apiResponse("sendMessage", {
      chat_id: chatId,
      text: `Каталог\nRun: ${run.id}\nСтатус: ${run.status}\nКандидатов: ${run.candidate_count}\nВ очереди: ${counts.queued}; leased: ${counts.leased}\nОбработано: ${processed}/50\nУспешно: ${counts.succeeded}; недоступно: ${counts.unavailable}; ошибок: ${counts.failed}; отменено: ${counts.cancelled}${pause}`,
    });
  }

  if (command === "/catalog_plan") {
    const db = database();
    const { data: launch, error: launchError } = await db.from("chestny_catalog_launches")
      .select("id,status,name").eq("name", "local-catalog-1000-20261007").maybeSingle();
    if (launchError) throw new Error("Could not read catalog launch plan");
    if (!launch) return apiResponse("sendMessage", { chat_id: chatId, text: "План запуска каталога пока не найден." });
    const { data: brands, error } = await db.from("chestny_catalog_brand_search_status")
      .select("manufacturer,target,published_count,remaining_quota,candidate_backlog,search_offset,status")
      .eq("launch_id", launch.id).order("manufacturer");
    if (error) throw new Error("Could not read catalog quotas");
    const lines = (brands ?? []).map((brand: Record<string, unknown>) => `${brand.manufacturer}: ${brand.published_count}/${brand.target}, осталось ${brand.remaining_quota}, кандидатов ${brand.candidate_backlog}, offset ${brand.search_offset} (${brand.status})`);
    return apiResponse("sendMessage", { chat_id: chatId, text: `План ${launch.name} (${launch.status})\n${lines.join("\n")}`.slice(0, 3900) });
  }

  if (command === "/catalog_publish") {
    return apiResponse("sendMessage", {
      chat_id: chatId,
      text: "Публикация сейчас недоступна. Она откроется только после проверки отчёта пилота и отдельного подтверждения.",
    });
  }

  const supported = command === "/catalog_start" || command === "/catalog_resume" || command === "/catalog_stop" || command === "/catalog_pause";
  if (!supported) return noOp();
  const run = await currentRun(database());
  if (!run) return apiResponse("sendMessage", { chat_id: chatId, text: "Run каталога не найден." });
  if (!Number.isSafeInteger(update.update_id)) throw new Error("Telegram update_id is missing");

  if (command === "/catalog_start" || command === "/catalog_resume" || command === "/catalog_stop") {
    const kind = command === "/catalog_start" ? "start" : command === "/catalog_resume" ? "resume" : "stop";
    const counts = await queueCounts(database(), run.id);
    const callbackData = `catalog:confirm:${kind}:${run.id}:50`;
    const text = kind === "start"
      ? `Подтверди запуск run ${run.id}: максимум 50 кандидатов, по одной карточке за раз. Публикация выключена.`
      : kind === "resume" ? `Подтверди продолжение paused run ${run.id}, максимум 50 кандидатов.`
        : `Подтверди отмену run ${run.id}. В очереди ${counts.queued}, leased ${counts.leased}; queued будут отменены.`;
    return apiResponse("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: [[{ text: kind === "stop" ? "Подтвердить отмену" : "Подтвердить", callback_data: callbackData }]] },
    });
  }

  await enqueue({
    updateId: update.update_id!,
    actorId: actor.id,
    chatId,
    command: "pause",
    runId: run.id,
  });
  return apiResponse("sendMessage", {
    chat_id: chatId,
    text: `Пауза поставлена в очередь для run ${run.id}; worker остановится после текущей карточки.`,
  });
}

async function handleCallback(update: TelegramUpdate) {
  const callback = update.callback_query;
  const owner = ownerId();
  const actor = callback?.from;
  const chatId = callback?.message?.chat?.id;
  const data = callback?.data?.split(":") ?? [];
  if (!callback) return noOp();
  if (!owner || !actor || String(actor.id) !== owner || callback.message?.chat?.type !== "private" || String(chatId) !== owner) {
    return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа", show_alert: true });
  }
  if (data.length !== 5 || data[0] !== "catalog" || data[1] !== "confirm") {
    return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "Некорректная команда", show_alert: true });
  }
  const [, , command, runId, itemLimit] = data;
  if (!(command === "start" || command === "resume" || command === "stop") || !/^[0-9a-f-]{36}$/i.test(runId) || itemLimit !== "50") {
    return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "Некорректная команда", show_alert: true });
  }
  if (!Number.isSafeInteger(update.update_id) || !chatId) throw new Error("Telegram callback context is incomplete");
  const { data: run, error } = await database().from("chestny_enrichment_runs").select("status").eq("id", runId).maybeSingle();
  if (error || !run) return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "Run не найден", show_alert: true });
  const expected = command === "start" ? "approved" : command === "resume" ? "paused" : ["approved", "running", "paused"];
  if (Array.isArray(expected) ? !expected.includes(run.status) : run.status !== expected) {
    return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: `Run уже в статусе ${run.status}`, show_alert: true });
  }
  await enqueue({ updateId: update.update_id!, actorId: actor.id, chatId, command, runId });
  return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "Команда передана Mac mini" });
}

export async function POST(request: NextRequest) {
  if (!isValidSecret(request.headers.get("x-telegram-bot-api-secret-token"), process.env.TELEGRAM_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!ownerId()) return NextResponse.json({ error: "Catalog owner is not configured" }, { status: 503 });

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid Telegram update" }, { status: 400 });
  }

  try {
    if (update.callback_query) return await handleCallback(update);
    if (update.message) return await handleMessage(update);
    return noOp();
  } catch (error) {
    console.error("Catalog Telegram webhook failed:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Catalog command could not be processed" }, { status: 500 });
  }
}
