"use server";

import { redirect } from "next/navigation";
import { setAdminSession } from "@/lib/admin/session";

export async function login(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) redirect("/admin/login?error=1");
  await setAdminSession();
  redirect("/admin/leads");
}
