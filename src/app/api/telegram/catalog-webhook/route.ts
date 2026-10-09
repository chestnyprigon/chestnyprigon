import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { renderRunBrandProgress, summarizeRunBrandProgress, type RunQuota, type RunQueueRow } from "../../../../lib/catalog-telegram-run-report";

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
  started_at: string | null;
  source_file: string;
  rules: Record<string, unknown> | null;
  pause_reason: unknown;
};

type CatalogGoal = {
  id: string;
  goal: string;
  state: string;
  parameters: Record<string, unknown> | null;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  external_ref: string | null;
  updated_at: string;
};

const OWNER_MENU = {
  keyboard: [
    [{ text: "📊 Статус" }, { text: "📈 Квоты" }, { text: "🧾 Отчёт" }],
    [{ text: "⏸ Пауза" }, { text: "🛑 Остановить" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Выберите действие",
};

const MENU_COMMANDS: Record<string, string> = {
  "📊 статус": "/catalog_status",
  "📈 квоты": "/catalog_plan",
  "🧾 отчёт": "/catalog_report",
  "⏸ пауза": "/catalog_pause",
  "🛑 остановить": "/catalog_stop",
};


function publicationState(goal: CatalogGoal | null, run?: Run | null) {
  const parameters = goal?.parameters ?? {};
  if (parameters.publishAuthorized === true && parameters.pilotApproved === true
    && parameters.publicationMode === "whole_run") {
    return `Публикация цели: разрешена пакетно (до ${Number(parameters.publicationBatchLimit ?? parameters.maxItemsPerWave ?? 50)} карточек за волну); публикуются только одобренные screening карточки.`;
  }
  if (!goal && run?.rules?.publication === "manual-after-screening-and-price-audit") {
    return "Публикация: автоматического разрешения нет; после screening требуется отдельный аудит цен и ручное решение.";
  }
  if (!goal && run) return "Публикация: нет связанной цели Control Center; автоматическая публикация выключена.";
  return "Публикация цели: выключена; одобренные карточки не публикуются автоматически.";
}

function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" };
  return String(value ?? "").replace(/[&<>\"]/g, (character) => entities[character] ?? character);
}

function formatDate(value: unknown): string {
  if (!value) return "неизвестно";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "неизвестно";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short",
  }).format(date);
}

function runStateLabel(status: string): string {
  return ({ approved: "готов к обработке", running: "обрабатывается", paused: "приостановлен",
    completed: "завершён", cancelled: "остановлен" } as Record<string, string>)[status] ?? "состояние обновляется";
}

function pauseReasonLabel(value: unknown): string {
  if (!value || typeof value !== "object") return "Причина не указана.";
  const reason = value as Record<string, unknown>;
  const message = String(reason.message ?? "");
  if (reason.source === "wave_limit") {
    const limit = Number(reason.maxItems ?? 0);
    return `Достигнут лимит волны${limit ? ` — ${limit} карточек` : ""}. Остаток очереди сохранён и может быть продолжен следующей волной.`;
  }
  if (reason.source === "owner_transfer_to_mac_mini") {
    return "Безопасная передача worker между устройствами; очередь сохранена.";
  }
  const known: Record<string, string> = {
    "At least half the batch failed; local enrichment paused": "Воркер остановил волну: не менее половины последних карточек завершились ошибкой. Перед продолжением нужно разобраться с причинами.",
    "Another Encar enrichment worker holds the global Supabase lock": "Поиск остановлен: другой Encar worker уже использует общую блокировку базы данных.",
  };
  const source = reason.source === "local_worker_loop" ? "Локальный worker" : "Система";
  const description = known[message] ?? (message ? escapeHtml(message) : "Причина не указана.");
  return `${source}: ${description}${reason.observedAt ? ` (${formatDate(reason.observedAt)})` : ""}`;
}

function apiResponse(method: string, params: Record<string, unknown>) {
  const withMenu = method === "sendMessage" && !params.reply_markup
    ? { ...params, reply_markup: OWNER_MENU }
    : params;
  return NextResponse.json({ method, ...withMenu });
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
  const now = new Date().toISOString();
  const { data: lock, error: lockError } = await db.from("chestny_enrichment_worker_lock")
    .select("run_id").eq("lock_name", "chestny-catalog-enrichment").gt("expires_at", now).maybeSingle();
  if (lockError) throw new Error("Could not read current enrichment worker lock");
  if (lock?.run_id) {
    const active = await db.from("chestny_enrichment_runs")
      .select("id,status,candidate_count,created_at,started_at,source_file,rules,pause_reason,project")
      .eq("id", lock.run_id).maybeSingle();
    if (active.error) throw new Error("Could not read run held by the active worker");
    if (active.data?.project === "chestny-prigon") return active.data as Run;
  }

  const tasks = await db.from("control_center_tasks")
    .select("state,progress,external_ref").eq("module_id", "chestny-prigon.catalog")
    .in("state", ["queued", "preparing", "running", "ready"])
    .order("updated_at", { ascending: false }).limit(10);
  if (tasks.error) throw new Error("Could not read active catalog coordinator tasks");
  for (const task of tasks.data ?? []) {
    const stage = String((task.progress as Record<string, unknown> | null)?.stage ?? "");
    const isNewGoalWaitingToStart = task.state === "ready" && !task.external_ref
      && ["search_pending", "search_candidates", "start_worker", "owner_command"].includes(stage);
    if (isNewGoalWaitingToStart) return null;
    if (task.state === "running" && task.external_ref) {
      const activeTaskRun = await db.from("chestny_enrichment_runs")
        .select("id,status,candidate_count,created_at,started_at,source_file,rules,pause_reason")
        .eq("id", task.external_ref).maybeSingle();
      if (activeTaskRun.error) throw new Error("Could not read the run linked to the active coordinator task");
      if (activeTaskRun.data) return activeTaskRun.data as Run;
    }
  }

  // Ordinary local runs are not tied to a catalog-launch row. Prefer the most
  // recently resumed such run after each 50-item wave, when no worker lock exists.
  const localLive = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,started_at,source_file,rules,pause_reason")
    .eq("project", "chestny-prigon").eq("source_file", "local-live-encar-search")
    .in("status", ["approved", "running", "paused", "completed"])
    .order("started_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false })
    .limit(1).maybeSingle();
  if (localLive.error) throw new Error("Could not read the latest local Encar run");
  if (localLive.data) return localLive.data as Run;

  const { data: launch, error: launchError } = await db.from("chestny_catalog_launches")
    .select("id").eq("name", "local-catalog-1000-20261007").maybeSingle();
  if (launchError) throw new Error("Could not read catalog launch");
  if (!launch) return null;

  const active = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,started_at,source_file,rules,pause_reason")
    .in("status", ["approved", "running", "paused"])
    .contains("rules", { catalogLaunchId: launch.id })
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (active.error) throw new Error("Could not read active catalog run");
  if (active.data) return active.data as Run;

  const latest = await db.from("chestny_enrichment_runs")
    .select("id,status,candidate_count,created_at,started_at,source_file,rules,pause_reason")
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

async function goalForRun(db: ReturnType<typeof database>, runId: string): Promise<CatalogGoal | null> {
  const { data, error } = await db.from("control_center_tasks")
    .select("id,goal,state,parameters,progress,result,external_ref,updated_at")
    .eq("module_id", "chestny-prigon.catalog").eq("external_ref", runId).maybeSingle();
  if (error) throw new Error("Could not read catalog goal publication settings");
  return data as CatalogGoal | null;
}

function goalStateLabel(state: string) {
  return ({ queued: "в очереди", preparing: "подготовка", ready: "готова к следующему этапу",
    running: "выполняется", paused: "приостановлена", completed: "завершена",
    failed: "ошибка", cancelled: "остановлена" } as Record<string, string>)[state] ?? state;
}

function goalStageLabel(stage: unknown) {
  const value = String(stage ?? "подготовка");
  return ({ search_candidates: "поиск кандидатов", search_next_wave: "поиск следующей волны",
    search_pending: "поиск готовится", owner_command: "команда владельца", start_worker: "запуск обработки",
    worker_started: "обогащение и проверка", continue_wave: "продолжение очереди",
    next_wave_started: "обогащение и проверка", enrichment_screening: "обогащение и проверка",
    publish_wave: "пакетная публикация", published: "волна опубликована",
    paused_for_attention: "пауза: требуется разбор причины", pilot_review: "ожидает проверки пилота",
    goal_completed: "цель выполнена", search_exhausted: "новых кандидатов не найдено" } as Record<string, string>)[value] ?? "обработка";
}

function goalProgressLabel(goal: CatalogGoal, currentProcessed?: number) {
  const wave = Number(goal.progress?.waveNumber ?? 0);
  if (goal.parameters?.queueOnly === true) {
    const total = Number(goal.parameters.targetCandidates ?? 0);
    const processed = currentProcessed ?? Number(goal.progress?.processed ?? 0);
    return `Обработано ${processed} из ${total} кандидатов.`;
  }
  const target = Number(goal.parameters?.targetPublications ?? 1_000);
  const published = Number(goal.progress?.published ?? goal.progress?.publishedCount ?? 0);
  return `${wave ? `Волна ${wave}. ` : ""}Опубликовано по цели: ${published}/${target}. Этап: ${goalStageLabel(goal.progress?.stage)}.`;
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
  const messageText = message?.text?.trim() ?? "";
  const commandToken = messageText.split(/\s+/, 1)[0]?.replace(/@[^@]+$/, "").toLowerCase() ?? "";
  const command = MENU_COMMANDS[messageText.toLowerCase()] ?? commandToken;
  if (!privateOwnerMessage(update) || !message || !chatId || !actor) return noOp();

  if (command === "/start" || command === "/catalog" || command === "/catalog_help") {
    return apiResponse("sendMessage", {
      chat_id: chatId,
      disable_web_page_preview: true,
      text: `🚗 <b>Панель каталога</b>\n\nКнопки показывают статус, квоты и отчёт. Волны запускаются координатором последовательно. При необходимости можно поставить обработку на паузу или остановить её.\n\nПубликация выполняется координатором после screening, только если цель получила необходимые разрешения.`,
      parse_mode: "HTML",
      reply_markup: OWNER_MENU,
    });
  }

  if (command === "/catalog_status" || command === "/catalog_report") {
    const db = database();
    const run = await currentRun(db);
    const goal = run ? await goalForRun(db, run.id) : null;

    const reportTitle = command === "/catalog_report" ? "🧾 Отчёт по каталогу" : "🚗 Статус каталога";
    if (!run) {
      const { data: latestGoal, error } = await db.from("control_center_tasks").select("goal,state,parameters,progress,result,updated_at")
        .eq("module_id", "chestny-prigon.catalog").order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("Could not read catalog goal status");
      return apiResponse("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: latestGoal
        ? `${reportTitle}\n\n<b>Цель:</b> ${escapeHtml(latestGoal.goal)}\n<b>Состояние:</b> ${goalStateLabel(latestGoal.state)}\n${goalProgressLabel(latestGoal as CatalogGoal)}\n${publicationState(latestGoal as CatalogGoal)}\n<b>Обновлено:</b> ${formatDate(latestGoal.updated_at)}`
        : "Run каталога пока не найден. Используй /catalog_start, чтобы создать подтверждаемую пилотную цель." });
    }
    const counts = await queueCounts(db, run.id);
    const decisions = await decisionCounts(db, run.id);
    const processed = counts.succeeded + counts.unavailable + counts.failed;
    const pause = run.pause_reason ? `\n\n⚠️ <b>Почему остановилось</b>\n${pauseReasonLabel(run.pause_reason)}` : "";
    const wave = Number(goal?.progress?.waveNumber ?? 0);
    const stage = goalStageLabel(goal?.progress?.stage);
    const title = command === "/catalog_report" ? "🧾 Отчёт по каталогу" : "🚗 Статус каталога";
    return apiResponse("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `${title}\n\n${goal ? `<b>Цель:</b> ${escapeHtml(goal.goal)}\n<b>Состояние цели:</b> ${escapeHtml(goalStateLabel(goal.state))}\n${wave ? `<b>Волна:</b> ${wave}\n` : ""}<b>Прогресс цели:</b> ${goalProgressLabel(goal, processed)}\n<b>Этап:</b> ${escapeHtml(stage)}\n` : `<b>Режим:</b> сохранённая очередь отдельного Encar run; Control Center цель не связана.\n`}<b>Текущая волна</b>\n<b>Состояние:</b> ${runStateLabel(run.status)}\n<b>Обработано:</b> ${processed} из ${run.candidate_count}\n<b>Очередь:</b> ${counts.queued} ждут · ${counts.leased} в работе\n<b>Обогащение:</b> ${counts.succeeded} успешно · ${counts.unavailable} недоступно · ${counts.failed} ошибок\n<b>Отбор:</b> ${decisions.approved} допущено · ${decisions.rejected} отклонено · ${decisions.isolated} изолировано\n<b>Запуск:</b> <code>${run.id}</code>${pause}\n\n<b>Публикация:</b> ${publicationState(goal, run)}\n<b>Обновлено:</b> ${formatDate(goal?.updated_at ?? run.started_at ?? run.created_at)}`,
    });
  }

  if (command === "/catalog_plan") {
    const db = database();
    const run = await currentRun(db);
    const runQuotas = Array.isArray(run?.rules?.brandQuotas) ? run.rules.brandQuotas.flatMap((item): RunQuota[] => {
      if (!item || typeof item !== "object") return [];
      const quota = item as Record<string, unknown>;
      return typeof quota.manufacturer === "string" && Number.isFinite(Number(quota.candidates))
        ? [{ manufacturer: quota.manufacturer, candidates: Number(quota.candidates) }] : [];
    }) : [];
    if (run && runQuotas.length) {
      const queueRows: RunQueueRow[] = [];
      for (let from = 0; ; from += 1_000) {
        const { data, error } = await db.from("chestny_enrichment_queue")
          .select("status,manufacturer:candidate_snapshot->>Manufacturer").eq("run_id", run.id)
          .order("id").range(from, from + 999);
        if (error) throw new Error("Could not read current run brand progress");
        queueRows.push(...(data ?? []) as RunQueueRow[]);
        if (!data || data.length < 1_000) break;
      }
      const progress = summarizeRunBrandProgress(runQuotas, queueRows);
      return apiResponse("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: renderRunBrandProgress({
        runId: run.id,
        plannedCandidates: runQuotas.reduce((sum, quota) => sum + quota.candidates, 0),
        candidateCount: run.candidate_count,
        progress,
      }) });
    }
    const { data: launch, error: launchError } = await db.from("chestny_catalog_launches")
      .select("id,status,name").eq("name", "local-catalog-1000-20261007").maybeSingle();
    if (launchError) throw new Error("Could not read catalog launch plan");
    if (!launch) return apiResponse("sendMessage", { chat_id: chatId, text: "План запуска каталога пока не найден." });
    const { data: brands, error } = await db.from("chestny_catalog_brand_search_status")
      .select("manufacturer,target,published_count,remaining_quota,candidate_count,search_offset,scanned_count,status,last_error")
      .eq("launch_id", launch.id).order("manufacturer");
    if (error) throw new Error("Could not read catalog quotas");
    const searchStatus = (status: unknown) => status === "ready" ? "🔎 поиск доступен"
      : status === "searching" ? "⏳ поиск идёт"
        : status === "exhausted" ? "⛔ выдача исчерпана"
          : status === "paused" ? "⏸ поиск на паузе" : "поиск ещё не запускался";
    const allBrands = (brands ?? []) as Record<string, unknown>[];
    const targetTotal = allBrands.reduce((sum, brand) => sum + Number(brand.target ?? 0), 0);
    const publishedTotal = allBrands.reduce((sum, brand) => sum + Number(brand.published_count ?? 0), 0);
    const remainingTotal = allBrands.reduce((sum, brand) => sum + Number(brand.remaining_quota ?? 0), 0);
    const lines = allBrands.filter((brand) => Number(brand.remaining_quota ?? 0) > 0).map((brand) =>
      `• <b>${escapeHtml(brand.manufacturer)}</b> — ${Number(brand.published_count ?? 0)}/${Number(brand.target ?? 0)} опубликовано; осталось ${Number(brand.remaining_quota ?? 0)}; кандидатов ${Number(brand.candidate_count ?? 0)}; просмотрено ${Number(brand.scanned_count ?? 0)}; позиция ${Number(brand.search_offset ?? 0)} · ${searchStatus(brand.status)}`);
    return apiResponse("sendMessage", { chat_id: chatId, parse_mode: "HTML",
      text: `📈 <b>Квоты каталога</b>\nОпубликовано: ${publishedTotal} из ${targetTotal} · осталось ${remainingTotal}\n\n«Кандидатов» — найденные объявления; «просмотрено» — объявления, проверенные при поиске; «позиция» — откуда поиск продолжится.\n\n${lines.join("\n")}` });
  }

  if (command === "/catalog_publish") {
    const db = database();
    const run = await currentRun(db);
    const goal = run ? await goalForRun(db, run.id) : null;
    return apiResponse("sendMessage", {
      chat_id: chatId,
      text: `${publicationState(goal, run)}\n${goal ? `Этап цели: ${goalStageLabel(goal.progress?.stage)}. Публикацией управляет координатор после завершения screening волны.` : "Для текущего run нет связанной цели Control Center."}${run ? `\nТекущий run: ${run.id} (${run.status}).` : ""}`,
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
      const goal = await goalForRun(db, run.id);
      const callbackData = `catalog:confirm:start:${run.id}:50`;
      return apiResponse("sendMessage", {
        chat_id: chatId,
        text: `Предыдущая волна завершена. Подтверди следующую: поиск по недостающим квотам, сверка ID, обогащение и screening до 50 кандидатов. ${publicationState(goal)} При разрешении координатор запустит пакетную публикацию допущенных карточек после screening.`,
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
    const goal = await goalForRun(db, run.id);
    const callbackData = `catalog:confirm:${kind}:${run.id}:50`;
    const text = kind === "start"
      ? `Подтверди обработку уже найденных кандидатов run ${run.id}: до 50 карточек, по одной за раз. Новый поиск эта команда не запускает. ${publicationState(goal)} После screening координатор отдельно отчитается о публикационном этапе.`
      : kind === "resume" ? `Подтверди продолжение run ${run.id}: до 50 следующих кандидатов из сохранённой очереди. ${publicationState(goal)} После screening координатор отдельно отчитается о публикационном этапе.`
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
