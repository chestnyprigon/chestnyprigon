import { readTelegramBotToken } from "./telegram-keychain";

export async function notifyCatalogOwner(text: string) {
  const ownerId = process.env.TELEGRAM_CATALOG_OWNER_ID?.trim();
  if (!ownerId || !/^\d{5,15}$/.test(ownerId)) throw new Error("TELEGRAM_CATALOG_OWNER_ID is missing or invalid");
  const token = readTelegramBotToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ownerId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage returned HTTP ${response.status}`);
}
