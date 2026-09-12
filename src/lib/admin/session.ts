import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const cookieName = "cp_admin";

function token() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update("chestny-prigon-admin").digest("hex");
}

export async function isAdmin() {
  const expected = token();
  const actual = (await cookies()).get(cookieName)?.value;
  return Boolean(expected && actual && expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual)));
}

export async function setAdminSession() {
  const value = token();
  if (!value) throw new Error("ADMIN_SESSION_SECRET is not configured");
  (await cookies()).set(cookieName, value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 14 });
}

export async function requireAdmin() {
  if (!await isAdmin()) throw new Error("Unauthorized");
}
