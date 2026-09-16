import "server-only";

type LeadNotification = {
  id: string;
  publicNumber: number;
  name: string;
  phone: string;
  message: string | null;
  source: string;
  pageUrl: string | null;
  vehicleSnapshot?: unknown;
  calculationSnapshot?: unknown;
  topic?: "new" | "work" | "contacted";
};

function value(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function sourceLabel(source: string) {
  return ({ homepage: "Главная страница", vehicle: "Карточка автомобиля", calculator: "Калькулятор", callback: "Обратный звонок" } as Record<string, string>)[source] ?? source;
}

function vehicleLines(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const item = snapshot as Record<string, unknown>;
  return [
    `Автомобиль: ${[item.brand, item.model].filter(Boolean).join(" ") || "—"}`,
    item.trim ? `Комплектация: ${value(item.trim)}` : "",
    item.year ? `Год: ${value(item.year)}` : "",
    item.mileage ? `Пробег: ${value(item.mileage)} км` : "",
    item.sourceUrl ? `Объявление: ${value(item.sourceUrl)}` : "",
  ].filter(Boolean);
}

function calculationLines(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const item = snapshot as Record<string, unknown>;
  return [
    item.totalUsd ? `Предварительно под ключ: $${value(item.totalUsd)}` : "",
    item.preferential !== undefined ? `Льготная растаможка: ${item.preferential ? "включена" : "не включена"}` : "",
  ].filter(Boolean);
}

export async function sendLeadNotification(lead: LeadNotification) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_GROUP_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram lead notification is not configured");

  const vehicle = vehicleLines(lead.vehicleSnapshot);
  const calculation = calculationLines(lead.calculationSnapshot);
  const text = [
    `🔥 Новая заявка #CP-${lead.publicNumber}`,
    "",
    `Источник: ${sourceLabel(lead.source)}`,
    `Имя: ${lead.name}`,
    `Телефон: ${lead.phone}`,
    `Комментарий: ${value(lead.message)}`,
    vehicle.length ? ["", ...vehicle].join("\n") : "",
    calculation.length ? ["", "Расчёт", ...calculation].join("\n") : "",
    lead.pageUrl ? `Страница: ${lead.pageUrl}` : "",
    "",
    "Статус: Новая",
  ].filter(Boolean).join("\n");

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const buttons = [{ text: "✅ Взять в работу", callback_data: `lead:take:${lead.id}` }];
  if (siteUrl?.startsWith("https://")) buttons.push({ text: "📂 Открыть заявку", url: `${siteUrl}/admin/leads/${lead.id}` } as never);
  const topicId = lead.topic === "work" ? process.env.TELEGRAM_TOPIC_WORK : lead.topic === "contacted" ? process.env.TELEGRAM_TOPIC_CONTACTED : process.env.TELEGRAM_TOPIC_NEW;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(topicId ? { message_thread_id: Number(topicId) } : {}),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [buttons] },
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { description?: string } | null;
    throw new Error(`Telegram returned ${response.status}: ${error?.description ?? "unknown error"}`);
  }
}
