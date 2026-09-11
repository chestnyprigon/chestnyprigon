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
};

function value(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function sourceLabel(source: string) {
  return ({ homepage: "Главная страница", vehicle: "Карточка автомобиля", calculator: "Калькулятор", callback: "Обратный звонок" } as Record<string, string>)[source] ?? source;
}

export async function sendLeadNotification(lead: LeadNotification) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram lead notification is not configured");

  const vehicle = lead.vehicleSnapshot ? `\nАвтомобиль: ${value(lead.vehicleSnapshot)}` : "";
  const calculation = lead.calculationSnapshot ? `\nРасчёт: ${value(lead.calculationSnapshot)}` : "";
  const text = [
    `🔥 Новая заявка #CP-${lead.publicNumber}`,
    "",
    `Источник: ${sourceLabel(lead.source)}`,
    `Имя: ${lead.name}`,
    `Телефон: ${lead.phone}`,
    `Комментарий: ${value(lead.message)}`,
    vehicle,
    calculation,
    lead.pageUrl ? `Страница: ${lead.pageUrl}` : "",
    "",
    "Статус: Новая",
  ].filter(Boolean).join("\n");

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const buttons = [{ text: "✅ Взять в работу", callback_data: `lead:take:${lead.id}` }];
  if (siteUrl?.startsWith("https://")) buttons.push({ text: "📂 Открыть заявку", url: `${siteUrl}/admin/leads/${lead.id}` } as never);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [buttons] },
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { description?: string } | null;
    throw new Error(`Telegram returned ${response.status}: ${error?.description ?? "unknown error"}`);
  }
}
