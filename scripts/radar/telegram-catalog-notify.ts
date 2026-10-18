import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readTelegramBotToken } from "./telegram-keychain";

type TelegramReplyMarkup = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
type QueuedTelegramMessage = { chatId: number | string; text: string; replyMarkup?: TelegramReplyMarkup; createdAt: string };

const notificationDirectory = join(homedir(), "Library", "Application Support", "chestny-prigon");
const notificationOutbox = join(notificationDirectory, "telegram-outbox.jsonl");
const notificationOutboxLock = join(notificationDirectory, "telegram-outbox.lock");

export async function sendTelegramMessage(
  token: string,
  chatId: number | string,
  text: string,
  replyMarkup?: TelegramReplyMarkup,
) {
  const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
  const delaysMs = [0, 1_000, 3_000];
  let lastError: unknown;

  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    if (delaysMs[attempt]) await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) {
        const result = await response.json() as { ok?: boolean; description?: string };
        if (result.ok !== false) return;
        lastError = new Error(`Telegram sendMessage failed: ${result.description ?? "unknown API error"}`);
        // Telegram validation/auth errors will not improve on retry.
        break;
      }
      lastError = new Error(`Telegram sendMessage returned HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Telegram sendMessage failed"));
}

async function enqueueTelegramMessage(message: QueuedTelegramMessage) {
  await mkdir(notificationDirectory, { recursive: true, mode: 0o700 });
  await appendFile(notificationOutbox, `${JSON.stringify(message)}\n`, { mode: 0o600 });
}

export async function sendTelegramWithOutbox(
  token: string,
  chatId: number | string,
  text: string,
  replyMarkup?: TelegramReplyMarkup,
) {
  try {
    await sendTelegramMessage(token, chatId, text, replyMarkup);
  } catch (error) {
    await enqueueTelegramMessage({ chatId, text, ...(replyMarkup ? { replyMarkup } : {}), createdAt: new Date().toISOString() });
    console.error(`Telegram notification saved for retry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function flushTelegramOutbox(token: string) {
  await mkdir(notificationDirectory, { recursive: true, mode: 0o700 });
  const lock = await open(notificationOutboxLock, "wx", 0o600).catch(() => null);
  if (!lock) return 0;

  let delivered = 0;
  const processingPath = join(notificationDirectory, `telegram-outbox.processing.${randomUUID()}.jsonl`);
  try {
    const pendingFiles = (await readdir(notificationDirectory))
      .filter((name) => name.startsWith("telegram-outbox.processing.") && name.endsWith(".jsonl"))
      .map((name) => join(notificationDirectory, name));
    const hasOutbox = await readFile(notificationOutbox, "utf8").then(() => true).catch(() => false);
    if (hasOutbox) {
      await rename(notificationOutbox, processingPath);
      pendingFiles.push(processingPath);
    }
    if (!pendingFiles.length) return 0;

    const messages: QueuedTelegramMessage[] = [];
    for (const file of pendingFiles) {
      const content = await readFile(file, "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try { messages.push(JSON.parse(line) as QueuedTelegramMessage); }
        catch { console.error(`Skipping malformed Telegram outbox entry in ${file}`); }
      }
    }
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!messages.length) {
      for (const file of pendingFiles) await rm(file, { force: true });
      return 0;
    }

    const tempPath = `${processingPath}.tmp`;
    await writeFile(tempPath, `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, { mode: 0o600 });
    await rename(tempPath, processingPath);
    for (const file of pendingFiles) {
      if (file !== processingPath) await rm(file, { force: true });
    }
    for (let index = 0; index < messages.length; index += 1) {
      try {
        const message = messages[index];
        await sendTelegramMessage(token, message.chatId, message.text, message.replyMarkup);
        delivered += 1;
        const remaining = messages.slice(index + 1);
        if (remaining.length) {
          await writeFile(tempPath, `${remaining.map((message) => JSON.stringify(message)).join("\n")}\n`, { mode: 0o600 });
          await rename(tempPath, processingPath);
        } else {
          await rm(processingPath, { force: true });
        }
      } catch (error) {
        const remaining = messages.slice(index);
        await writeFile(tempPath, `${remaining.map((message) => JSON.stringify(message)).join("\n")}\n`, { mode: 0o600 });
        await rename(tempPath, processingPath);
        console.error(`Telegram outbox delivery deferred: ${error instanceof Error ? error.message : String(error)}`);
        return delivered;
      }
    }
    return delivered;
  } finally {
    await lock.close().catch(() => undefined);
    await rm(notificationOutboxLock, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function notifyCatalogOwner(text: string, replyMarkup?: TelegramReplyMarkup) {
  const ownerId = process.env.TELEGRAM_CATALOG_OWNER_ID?.trim();
  if (!ownerId || !/^\d{5,15}$/.test(ownerId)) throw new Error("TELEGRAM_CATALOG_OWNER_ID is missing or invalid");
  const token = readTelegramBotToken();
  await flushTelegramOutbox(token);
  await sendTelegramWithOutbox(token, ownerId, text, replyMarkup);
}
