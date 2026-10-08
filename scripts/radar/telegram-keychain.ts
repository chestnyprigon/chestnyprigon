import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function readTelegramBotToken() {
  const helper = join(process.cwd(), "scripts/radar/read-telegram-bot-token.swift");
  const token = execFileSync("/usr/bin/swift", [helper], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (!token) throw new Error("Telegram bot token is missing from macOS Keychain");
  return token;
}
