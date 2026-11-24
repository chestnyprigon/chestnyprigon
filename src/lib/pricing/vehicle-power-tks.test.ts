import assert from "node:assert/strict";
import test from "node:test";
import { resolveBestPowerRecord } from "./vehicle-power-tks";

test("Chestny Prigon resolver requests Vehicle Power catalog-only and never enables AI research", async () => {
  const priorBaseUrl = process.env.VEHICLE_POWER_API_BASE_URL;
  const priorToken = process.env.VEHICLE_POWER_RESOLVE_TOKEN;
  const priorFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  process.env.VEHICLE_POWER_API_BASE_URL = "https://power.koredigital.co.kr";
  process.env.VEHICLE_POWER_RESOLVE_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      status: "NOT_FOUND",
      resolutionClass: "INSUFFICIENT_DATA",
      referenceVersion: "test-reference",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await assert.rejects(
      resolveBestPowerRecord({ brand: "Toyota", model: "Prius", year: 2026, engineCc: 1987 }),
      /No usable preliminary power record/,
    );
    assert.equal(requestBody?.researchMode, "catalog_only");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorBaseUrl == null) delete process.env.VEHICLE_POWER_API_BASE_URL;
    else process.env.VEHICLE_POWER_API_BASE_URL = priorBaseUrl;
    if (priorToken == null) delete process.env.VEHICLE_POWER_RESOLVE_TOKEN;
    else process.env.VEHICLE_POWER_RESOLVE_TOKEN = priorToken;
  }
});
