const API_ORIGIN = "https://api.encar.com";
const VERIFY_IP_ENDPOINT = `${API_ORIGIN}/international/communication/validate-request-ip`;
const VERIFY_ENDPOINT = `${API_ORIGIN}/pass/user/verify`;
const PUBLIC_IP_ENDPOINT = "https://api.ipify.org?format=json";

export const ENCAR_USER_AGENT =
  process.env.ENCAR_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const baseHeaders: Record<string, string> = {
  "User-Agent": ENCAR_USER_AGENT,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  Referer: "https://car.encar.com/",
  Origin: "https://car.encar.com",
};

const browserVerificationHeaders: Record<string, string> = {
  ...baseHeaders,
  Referer: "https://fem.encar.com/",
  Origin: "https://fem.encar.com",
};

type RequestIpResponse = {
  ipAddress?: unknown;
  ip?: unknown;
};

type VerifyResponse = {
  status?: unknown;
};

let verificationPromise: Promise<void> | null = null;

export function encarHeaders(extra: Record<string, string> = {}) {
  return { ...baseHeaders, ...extra };
}

async function verifyRequestIp() {
  const ipResponse = await fetch(VERIFY_IP_ENDPOINT, {
    headers: encarHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  let ipAddress = "";
  if (ipResponse.ok) {
    const ipPayload = (await ipResponse.json()) as RequestIpResponse;
    ipAddress = typeof ipPayload.ipAddress === "string" ? ipPayload.ipAddress.trim() : "";
  } else if (ipResponse.status === 401) {
    // Encar's IP endpoint may require a browser-only bearer token even though
    // /pass/user/verify itself accepts the current egress IP and User-Agent.
    const publicIpResponse = await fetch(PUBLIC_IP_ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (publicIpResponse.ok) {
      const publicIpPayload = (await publicIpResponse.json()) as RequestIpResponse;
      const fallbackIp = publicIpPayload.ipAddress ?? publicIpPayload.ip;
      ipAddress = typeof fallbackIp === "string" ? fallbackIp.trim() : "";
    }
  } else {
    throw new Error(`Encar IP validation returned HTTP ${ipResponse.status}`);
  }

  if (!ipAddress) throw new Error("Encar IP validation did not return an IP address");

  const verifyResponse = await fetch(VERIFY_ENDPOINT, {
    method: "POST",
    headers: { ...browserVerificationHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      userIdentifier: {
        ipAddress,
        userAgent: ENCAR_USER_AGENT,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!verifyResponse.ok) {
    throw new Error(`Encar user verification returned HTTP ${verifyResponse.status}`);
  }

  const verifyPayload = (await verifyResponse.json()) as VerifyResponse;
  if (verifyPayload.status !== "VERIFIED") {
    throw new Error(`Encar user verification failed: ${String(verifyPayload.status ?? "unknown")}`);
  }
}

/** Verify the current egress IP once per parser process before API requests. */
export async function ensureEncarVerified() {
  if (!verificationPromise) {
    verificationPromise = verifyRequestIp().catch((error) => {
      verificationPromise = null;
      throw error;
    });
  }
  await verificationPromise;
}
