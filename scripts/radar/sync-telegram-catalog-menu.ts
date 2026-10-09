import { config } from "dotenv";
import { readTelegramBotToken } from "./telegram-keychain";

config({ path: ".env.local", quiet: true });

async function main() {
  const owner = process.env.TELEGRAM_CATALOG_OWNER_ID?.trim();
  if (!owner || !/^\d{5,15}$/.test(owner)) throw new Error("Catalog owner ID is not configured");
  const token = readTelegramBotToken();
  async function api(method: string, body: Record<string, unknown> = {}) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as { ok: boolean; result: unknown; description?: string };
    if (!response.ok || !result.ok) throw new Error(`${method}: ${result.description ?? response.status}`);
    return result.result;
  }
  const bot = await api("getMe") as { first_name: string; username: string };
  if (bot.first_name !== "Обогащение каталога ЧП") throw new Error(`Unexpected bot: ${bot.first_name}; menu was not changed`);
  const scopes = [{ type: "default" }, { type: "all_private_chats" }, { type: "chat", chat_id: Number(owner) }];
  const commands = [{ command: "start", description: "Открыть панель каталога" }];
  const checks = [];
  for (const scope of scopes) for (const language_code of ["", "ru", "en"]) {
    const settings = { scope, language_code };
    const before = await api("getMyCommands", settings) as { command: string }[];
    await api("setMyCommands", { ...settings, commands });
    const after = await api("getMyCommands", settings) as { command: string }[];
    if (after.length !== 1 || after[0].command !== "start") throw new Error("Telegram command list verification failed");
    checks.push({ ...settings, before: before.map((item) => item.command), after: after.map((item) => item.command) });
  }
  console.log(JSON.stringify({ status: "verified", bot: bot.username, checks }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Could not synchronize catalog bot menu");
  process.exitCode = 1;
});
