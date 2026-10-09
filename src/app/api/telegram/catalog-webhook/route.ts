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

type CatalogGoal = {
  id: string;
  goal: string;
  state: string;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  external_ref: string | null;
  updated_at: string;
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
  const { data: launch, error: launchError } = await db.from("chestny_catalog_launches")
    .select("id").eq("name", "local-catalog-1000-20261007").maybeSingle();
  if (launchError) throw new Error("Could not read catalog launch");
  if (!launch) return null;

  const active = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,pause_reason")
    .in("status", ["approved", "running", "paused"])
    .contains("rules", { catalogLaunchId: launch.id })
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (active.error) throw new Error("Could not read active catalog run");
  if (active.data) return active.data as Run;

  const latest = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,pause_reason")
    .contains("rules", { catalogLaunchId: launch.id })
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw new Error("Could not read latest catalog run");
  return latest.data as Run | null;
}

async function pilotGoalButton(db: ReturnType<typeof database>, chatId: number) {
  const { data: launch, error } = await db.from("chestny_catalog_launches").select("id,name,status")
    .eq("name", "local-catalog-1000-20261007").maybeSingle();
  if (error) throw new Error("Could not read catalog launch plan");
  if (!launch || !["prepared", "running"].includes(launch.status)) {
    return apiResponse("sendMessage", { chat_id: chatId, text: launch
      ? `План ${launch.name} имеет статус ${launch.status}; новую пилотную цель сейчас создать нельзя.`
      : "План запуска каталога не найден; новую пилотную цель создать нельзя." });
  }
  return apiResponse("sendMessage", {
    chat_id: chatId,
    text: "Создать отдельную пилотную цель? Координатор выполнит поиск по недостающим квотам, сформирует новую очередь и проведёт обогащение со screening. Старый paused run и его очередь останутся без изменений. Публикация выключена.",
    reply_markup: { inline_keyboard: [[{ text: "Создать пилотную цель", callback_data: `catalog:confirm:goal:${launch.id}:50` }]] },
  });
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

async function decisionCounts(db: ReturnType<typeof database>, runId: string) {
  const decisions = ["approved", "rejected", "isolated"];
  const entries = await Promise.all(decisions.map(async (decision) => {
    const { count, error } = await db.from("chestny_catalog_decisions")
      .select("source_listing_id", { count: "exact", head: true })
      .eq("run_id", runId).eq("decision", decision);
    if (error) throw new Error("Could not read catalog screening decisions");
    return [decision, count ?? 0] as const;
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
      text: "Пульт каталога:\n/catalog_status — этап и очередь текущего запуска\n/catalog_plan — квоты, найденные кандидаты и прогресс поиска\n/catalog_report — результаты обогащения и screening\n/catalog_start — обработать подготовленную волну или найти следующую по квотам\n/catalog_pause — пауза после текущей карточки\n/catalog_resume — обработать до 50 следующих кандидатов из очереди\n/catalog_stop — отменить текущий run\n/catalog_publish — публикация закрыта до отдельного решения после пилота\n\nНовая волна запускает последовательный поиск Encar, сверку с БД, обогащение и screening. Публикация автоматически не выполняется.",
    });
  }

  if (command === "/catalog_status" || command === "/catalog_report") {
    const db = database();
    const previousRun = await currentRun(db);
    const { data: launch } = await db.from("chestny_catalog_launches").select("id")
      .eq("name", "local-catalog-1000-20261007").maybeSingle();
    let goal: CatalogGoal | null = null;
    if (launch) {
      const { data, error } = await db.from("control_center_tasks")
        .select("id,goal,state,progress,result,external_ref,updated_at").eq("module_id", "chestny-prigon.catalog")
        .contains("parameters", { launchId: launch.id }).in("state", ["queued", "preparing", "ready", "running", "paused"])
        .order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("Could not read active catalog goal status");
      goal = data as CatalogGoal | null;
    }

    let run = previousRun;
    if (goal?.external_ref) {
      const { data, error } = await db.from("chestny_enrichment_runs")
        .select("id,status,candidate_count,created_at,pause_reason").eq("id", goal.external_ref).maybeSingle();
      if (error) throw new Error("Could not read the run linked to the active catalog goal");
      if (data) run = data as Run;
    }
    const previousRunNote = previousRun && run && previousRun.id !== run.id
      ? `\nПредыдущая волна: ${previousRun.id} (${previousRun.status}); её очередь сохранена без изменений.` : "";

    if (goal && !goal.external_ref) return apiResponse("sendMessage", { chat_id: chatId,
      text: `Цель: ${goal.goal}\nСостояние: ${goal.state}\nЭтап: ${String(goal.progress?.stage ?? "подготовка")}\nПрогресс: ${JSON.stringify(goal.progress ?? {}).slice(0, 500)}\nЗадача обновлена: ${goal.updated_at}${previousRunNote}\nПубликация не запускается.` });
    if (!run) {
      const { data: latestGoal, error } = await db.from("control_center_tasks").select("goal,state,progress,result,updated_at")
        .eq("module_id", "chestny-prigon.catalog").order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("Could not read catalog goal status");
      return apiResponse("sendMessage", { chat_id: chatId, text: latestGoal
        ? `Цель: ${latestGoal.goal}\nСостояние: ${latestGoal.state}\nЭтап: ${String(latestGoal.progress?.stage ?? "подготовка")}\nПрогресс: ${JSON.stringify(latestGoal.progress ?? {}).slice(0, 500)}\nЗадача обновлена: ${latestGoal.updated_at}\nПубликация не запускается.`
        : "Run каталога пока не найден. Используй /catalog_start, чтобы создать подтверждаемую пилотную цель." });
    }
    const counts = await queueCounts(db, run.id);
    const decisions = await decisionCounts(db, run.id);
    const processed = counts.succeeded + counts.unavailable + counts.failed;
    const pause = run.pause_reason ? `\nПричина паузы: ${JSON.stringify(run.pause_reason).slice(0, 500)}` : "";
    const phase = run.status === "approved" ? "ожидает команды на обработку"
      : run.status === "running" ? "обогащение"
        : run.status === "paused" ? "пауза"
          : run.status === "completed" ? "обогащение завершено"
            : run.status === "cancelled" ? "отменён" : run.status;
    return apiResponse("sendMessage", {
      chat_id: chatId,
      text: `${goal ? `Цель: ${goal.goal}\nОбщее состояние: ${goal.state}\nЭтап: ${String(goal.progress?.stage ?? "подготовка")}\nПрогресс цели: ${JSON.stringify(goal.progress ?? {}).slice(0, 350)}\nЗадача обновлена: ${goal.updated_at}\n\n` : "Цель Control Center ещё не связана с этим run.\n\n"}Каталог — ${phase}\nRun: ${run.id}\nСтатус: ${run.status}\nНайдено кандидатов: ${run.candidate_count}\nОбработано всего: ${processed}\nОчередь: ${counts.queued}; сейчас обрабатывается: ${counts.leased}\nОбогащено: ${counts.succeeded}; недоступно: ${counts.unavailable}; ошибок: ${counts.failed}; отменено: ${counts.cancelled}\nScreening: допущено ${decisions.approved}; отклонено ${decisions.rejected}; изолировано ${decisions.isolated}${goal?.result ? `\nРезультат/ожидание: ${JSON.stringify(goal.result).slice(0, 350)}` : ""}${pause}${previousRunNote}`,
    });
  }

  if (command === "/catalog_plan") {
    const db = database();
    const { data: launch, error: launchError } = await db.from("chestny_catalog_launches")
      .select("id,status,name").eq("name", "local-catalog-1000-20261007").maybeSingle();
    if (launchError) throw new Error("Could not read catalog launch plan");
    if (!launch) return apiResponse("sendMessage", { chat_id: chatId, text: "План запуска каталога пока не найден." });
    const { data: brands, error } = await db.from("chestny_catalog_brand_search_status")
      .select("manufacturer,target,published_count,remaining_quota,candidate_count,search_offset,scanned_count,status,last_error")
      .eq("launch_id", launch.id).gt("remaining_quota", 0).order("manufacturer");
    if (error) throw new Error("Could not read catalog quotas");
    const searchStatus = (status: unknown) => status === "ready" ? "можно искать дальше"
      : status === "searching" ? "идёт поиск"
        : status === "exhausted" ? "выдача исчерпана"
          : status === "paused" ? "поиск на паузе" : String(status ?? "не начат");
    const lines = (brands ?? []).map((brand: Record<string, unknown>) => `${brand.manufacturer}: публикации ${brand.published_count}/${brand.target}, осталось ${brand.remaining_quota}; найдено всего ${brand.candidate_count}; просмотрено ${brand.scanned_count}, offset ${brand.search_offset}; ${searchStatus(brand.status)}${brand.last_error ? ` — ${String(brand.last_error).slice(0, 120)}` : ""}`);
    return apiResponse("sendMessage", { chat_id: chatId, text: `План ${launch.name} (${launch.status})\nКвота — цель опубликованных карточек. «Найдено всего» — кандидаты из поиска, это ещё не число публикаций. Offset — позиция Encar для продолжения.\n${lines.join("\n")}`.slice(0, 3900) });
  }

  if (command === "/catalog_publish") {
    return apiResponse("sendMessage", {
      chat_id: chatId,
      text: "Публикация сейчас недоступна. Она откроется только после проверки отчёта пилота и отдельного подтверждения.",
    });
  }

  const supported = command === "/catalog_start" || command === "/catalog_resume" || command === "/catalog_stop" || command === "/catalog_pause";
  if (!supported) return noOp();
  const db = database();
  const run = await currentRun(db);
  if (!run) return command === "/catalog_start" ? pilotGoalButton(db, chatId)
    : apiResponse("sendMessage", { chat_id: chatId, text: "Run каталога не найден." });
  if (command === "/catalog_start" && run.status !== "approved") {
    if (["completed", "cancelled", "paused"].includes(run.status)) {
      const counts = await queueCounts(database(), run.id);
      if (counts.queued + counts.leased > 0) {
        const { data: launch, error: launchError } = await db.from("chestny_catalog_launches").select("id")
          .eq("name", "local-catalog-1000-20261007").maybeSingle();
        if (launchError) throw new Error("Could not read catalog launch plan");
        if (!launch) return apiResponse("sendMessage", { chat_id: chatId, text: "План запуска каталога не найден; отдельную пилотную цель создать нельзя." });
        return apiResponse("sendMessage", {
          chat_id: chatId,
          text: `Старая волна ${run.id} остановлена: ${counts.queued} кандидатов остались в очереди. Можно оставить её как есть и создать отдельную пилотную цель; новый поиск не будет использовать этот run.`,
          reply_markup: { inline_keyboard: [[{ text: "Создать отдельную пилотную цель", callback_data: `catalog:confirm:goal:${launch.id}:50` }]] },
        });
      }
      const callbackData = `catalog:confirm:start:${run.id}:50`;
      return apiResponse("sendMessage", {
        chat_id: chatId,
        text: `Предыдущая волна ${run.id} завершена или приостановлена без остатка в очереди. Подтверди новую: поиск по маркам с недобором квоты, исключение известных ID, обогащение до 50 карточек и автоматический screening. Публикация не выполняется.`,
        reply_markup: { inline_keyboard: [[{ text: "Начать следующую волну", callback_data: callbackData }]] },
      });
    }
    const guidance = run.status === "running" ? "Волна уже выполняется; смотри /catalog_status."
      : run.status === "paused" ? "Волна остановлена. Для продолжения используй /catalog_resume."
        : `Подготовленная волна имеет статус ${run.status}.`;
    return apiResponse("sendMessage", { chat_id: chatId, text: `${guidance}\n/catalog_start не запускает параллельную волну.` });
  }
  if (command === "/catalog_resume" && run.status !== "paused") {
    return apiResponse("sendMessage", { chat_id: chatId, text: run.status === "running"
      ? "Волна уже выполняется; смотри /catalog_status."
      : `Run в статусе ${run.status}; продолжить можно только paused run.` });
  }
  if (command === "/catalog_pause" && !["approved", "running"].includes(run.status)) {
    return apiResponse("sendMessage", { chat_id: chatId, text: `Run в статусе ${run.status}; поставить его на паузу нельзя.` });
  }
  if (!Number.isSafeInteger(update.update_id)) throw new Error("Telegram update_id is missing");

  if (command === "/catalog_start" || command === "/catalog_resume" || command === "/catalog_stop") {
    const kind = command === "/catalog_start" ? "start" : command === "/catalog_resume" ? "resume" : "stop";
    const counts = await queueCounts(database(), run.id);
    const callbackData = `catalog:confirm:${kind}:${run.id}:50`;
    const text = kind === "start"
      ? `Подтверди обработку уже найденных кандидатов run ${run.id}: до 50 новых карточек за эту волну, по одной за раз. Поиск новых объявлений и публикация не запускаются.`
      : kind === "resume" ? `Подтверди продолжение run ${run.id}: до 50 следующих кандидатов из очереди. Публикация не запускается.`
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
  if (!(command === "start" || command === "resume" || command === "stop" || command === "goal") || !/^[0-9a-f-]{36}$/i.test(runId) || itemLimit !== "50") {
    return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "Некорректная команда", show_alert: true });
  }
  if (!Number.isSafeInteger(update.update_id) || !chatId) throw new Error("Telegram callback context is incomplete");
  if (command === "goal") {
    const db = database();
    const { data, error } = await db.rpc("create_chestny_catalog_goal", { p_launch: runId, p_origin_update_id: update.update_id });
    if (error) return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: `Не удалось создать цель: ${error.message.slice(0, 180)}`, show_alert: true });
    const created = Boolean((data as Record<string, unknown> | null)?.created);
    return apiResponse("answerCallbackQuery", { callback_query_id: callback.id,
      text: created ? "Пилотная цель сохранена; координатор начнёт с поиска по квотам" : "Такая цель уже создана; координатор продолжит её", show_alert: false });
  }
  const { data: run, error } = await database().from("chestny_enrichment_runs").select("status").eq("id", runId).maybeSingle();
  if (error || !run) return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "Run не найден", show_alert: true });
  const expected = command === "start" ? ["approved", "completed", "cancelled", "paused"] : command === "resume" ? "paused" : ["approved", "running", "paused"];
  if (Array.isArray(expected) ? !expected.includes(run.status) : run.status !== expected) {
    return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: `Run уже в статусе ${run.status}`, show_alert: true });
  }
  if (command === "start" && ["completed", "cancelled", "paused"].includes(run.status)) {
    const counts = await queueCounts(database(), runId);
    if (counts.queued + counts.leased > 0) {
      return apiResponse("answerCallbackQuery", { callback_query_id: callback.id, text: "В предыдущей волне остались необработанные кандидаты", show_alert: true });
    }
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
