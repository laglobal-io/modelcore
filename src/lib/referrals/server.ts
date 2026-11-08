import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { parseRefCookie, REF_COOKIE, VISITOR_COOKIE, type RefCookie } from "./core";

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`${env.ipHashSalt()}:${ip}`).digest("hex");
}

export function clientIp(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || null;
}

export async function readRefCookie(): Promise<RefCookie | null> {
  const store = await cookies();
  return parseRefCookie(store.get(REF_COOKIE)?.value);
}

export function newVisitorId(): string {
  return randomUUID();
}

export { REF_COOKIE, VISITOR_COOKIE };
