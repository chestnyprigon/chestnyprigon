import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

let proxyAgent: ProxyAgent | undefined;
let configuredProxyUrl: string | undefined;

/** Read the proxy URL from the user's login Keychain without printing it. */
export function readEncarProxyUrlFromKeychain() {
  const script = join(process.cwd(), "scripts/radar/read-encar-proxy.swift");
  const value = execFileSync("/usr/bin/swift", [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Stored Encar proxy credential is not a valid URL");
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.port || !parsed.username || !parsed.password) {
    throw new Error("Stored Encar proxy credential is incomplete");
  }
  return value;
}

export function encarProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl = process.env.ENCAR_PROXY_URL?.trim();
  if (!proxyUrl) return undefined;
  if (proxyUrl !== configuredProxyUrl) {
    proxyAgent?.close();
    proxyAgent = new ProxyAgent(proxyUrl);
    configuredProxyUrl = proxyUrl;
  }
  return proxyAgent;
}

export async function encarFetch(url: URL | string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const dispatcher = encarProxyDispatcher();
  return undiciFetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) });
}
