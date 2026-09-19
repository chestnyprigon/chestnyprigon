import fs from "node:fs/promises";
import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

const counterId = process.env.YANDEX_METRIKA_COUNTER_ID?.trim() || "112810644";
const token = process.env.YANDEX_METRIKA_OAUTH_TOKEN?.trim();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!token) throw new Error("Missing YANDEX_METRIKA_OAUTH_TOKEN");
if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing Supabase service credentials");

const date = new Date();
date.setUTCDate(date.getUTCDate() - 1);
const periodEnd = process.env.METRIKA_DATE_TO?.trim() || date.toISOString().slice(0, 10);
const periodStart = process.env.METRIKA_DATE_FROM?.trim() || periodEnd;
const endpoint = "https://api-metrika.yandex.net/stat/v1/data";
const headers = { Authorization: `OAuth ${token}`, Accept: "application/json" };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(`Yandex Metrica API ${response.status}: ${payload.message ?? "request failed"}`);
  return payload;
}

async function report(metrics: string[], dimensions: string[], limit = "100") {
  const params = new URLSearchParams({
    ids: counterId,
    date1: periodStart,
    date2: periodEnd,
    metrics: metrics.join(","),
    dimensions: dimensions.join(","),
    limit,
    accuracy: "full",
  });
  return getJson(`${endpoint}?${params}`);
}

async function main() {
  const goalsPayload = await getJson<{ goals?: Array<{ id: number; name: string }> }>(
    `https://api-metrika.yandex.net/management/v1/counter/${counterId}/goals`,
  );
  const goals = (goalsPayload.goals ?? []).filter((goal) => ["vehicle_view", "filter_apply", "price_refresh", "lead_submit"].includes(goal.name));
  const [overview, sources] = await Promise.all([
    report(["ym:s:visits", "ym:s:users", "ym:s:pageviews", "ym:s:bounceRate"], ["ym:s:date"], "100"),
    report(["ym:s:visits", "ym:s:users", "ym:s:pageviews", "ym:s:bounceRate"], ["ym:s:UTMSource", "ym:s:UTMMedium", "ym:s:UTMCampaign", "ym:s:UTMContent"], "500"),
  ]);
  const goalReports: Record<string, unknown> = {};
  for (const goal of goals) {
    try {
      goalReports[goal.name] = await report([`ym:s:goal${goal.id}reaches`, `ym:s:goal${goal.id}conversionRate`], ["ym:s:UTMSource", "ym:s:UTMCampaign"], "500");
    } catch (error) {
      console.warn(`Goal report skipped for ${goal.name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  const payload = { counterId, periodStart, periodEnd, goals, overview, sources, goalReports, fetchedAt: new Date().toISOString() };
  const client = createClient(supabaseUrl!, serviceRoleKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.from("metrika_report_snapshots").upsert({ report_key: "daily", period_start: periodStart, period_end: periodEnd, payload }, { onConflict: "report_key,period_start,period_end" });
  if (error) throw error;
  const outputPath = path.resolve(process.cwd(), "output/metrika/latest.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "completed", counterId, periodStart, periodEnd, goals: goals.map((goal) => goal.name), outputPath }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
