import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isBot, normalizeCode, parseRefCookie, safeRedirectPath, serializeRefCookie,
  REF_COOKIE, REF_COOKIE_MAX_AGE_DAYS, VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE_DAYS,
} from "@/lib/referrals/core";
import { clientIp, hashIp, newVisitorId } from "@/lib/referrals/server";

export const dynamic = "force-dynamic";

/**
 * Referral link: modelcore.io/r/{code}?to=/sell&utm_source=...
 * Records a click, sets a first-touch cookie, then redirects. First touch wins:
 * an existing valid referral cookie is never overwritten by a later link.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const url = req.nextUrl;
  const dest = new URL(safeRedirectPath(url.searchParams.get("to")), url.origin);
  // Carry UTM params through to the landing page for analytics.
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
    const v = url.searchParams.get(k);
    if (v) dest.searchParams.set(k, v);
  }
  const res = NextResponse.redirect(dest, 302);
  res.headers.set("Cache-Control", "no-store");

  const code = normalizeCode(raw);
  if (!code) return res;

  const existing = parseRefCookie(req.cookies.get(REF_COOKIE)?.value);
  const ua = req.headers.get("user-agent");

  let visitorId = req.cookies.get(VISITOR_COOKIE)?.value;
  if (!visitorId || !/^[0-9a-f-]{36}$/i.test(visitorId)) visitorId = newVisitorId();
  const secure = url.protocol === "https:";
  res.cookies.set(VISITOR_COOKIE, visitorId, {
    httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: VISITOR_COOKIE_MAX_AGE_DAYS * 86400,
  });

  if (isBot(ua)) return res;

  const db = createAdminClient();
  const { data: partner } = await db
    .from("partners")
    .select("id, code")
    .eq("code", code)
    .eq("status", "active")
    .maybeSingle();
  if (!partner) return res;

  const { data: click } = await db
    .from("referral_clicks")
    .insert({
      partner_id: partner.id,
      visitor_id: visitorId,
      landing_path: dest.pathname,
      referrer: req.headers.get("referer")?.slice(0, 500) ?? null,
      utm_source: url.searchParams.get("utm_source"),
      utm_medium: url.searchParams.get("utm_medium"),
      utm_campaign: url.searchParams.get("utm_campaign"),
      country: req.headers.get("x-vercel-ip-country"),
      ip_hash: hashIp(clientIp(req.headers)),
      user_agent: ua?.slice(0, 300) ?? null,
    })
    .select("id, created_at")
    .single();

  if (!existing) {
    res.cookies.set(
      REF_COOKIE,
      serializeRefCookie({
        code: partner.code,
        clickId: click?.id ?? null,
        firstTouchAt: click?.created_at ?? new Date().toISOString(),
      }),
      { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: REF_COOKIE_MAX_AGE_DAYS * 86400 },
    );
  }
  return res;
}
