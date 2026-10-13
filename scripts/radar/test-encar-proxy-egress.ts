import { execFileSync } from "node:child_process";
import { ProxyAgent, fetch } from "undici";

async function main() {
  const proxyUrl = execFileSync("/usr/bin/swift", ["scripts/radar/read-encar-proxy.swift"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (!proxyUrl) throw new Error("Proxy credential is empty");

  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const response = await fetch("https://ip.decodo.com/json", {
      dispatcher,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Decodo IP check returned HTTP ${response.status}`);

    const payload = await response.json() as {
      ip?: unknown;
      country?: unknown;
      proxy?: { ip?: unknown; country?: unknown };
    };
    const ip = payload.proxy?.ip ?? payload.ip ?? null;
    const country = payload.proxy?.country ?? payload.country ?? null;
    console.log(JSON.stringify({ status: "ok", service: "Decodo IP check", ip, country }, null, 2));
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error && /^Decodo IP check returned HTTP \d+$/.test(error.message)
      ? error.message
      : `Proxy connectivity check failed (${name}); credential details were not logged.`;
    throw new Error(message);
  } finally {
    await dispatcher.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Proxy connectivity check failed.");
  process.exitCode = 1;
});
