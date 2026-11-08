import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { normalizeCode, safeRedirectPath } from "@/lib/referrals/core";
import { readRefCookie } from "@/lib/referrals/server";

const Body = z.object({
  role: z.enum(["seller", "buyer"]),
  answers: z.object({
    industry: z.string().max(80),
    data: z.array(z.string().max(80)).min(1).max(20),
    volume: z.string().max(80),
  }),
  contact: z.object({
    name: z.string().trim().min(1).max(120),
    company: z.string().trim().min(1).max(160),
    email: z.string().trim().email().max(254),
    website: z.string().trim().min(3).max(200),
    phone: z.string().trim().max(40).optional().default(""),
    source: z.string().max(80).optional().default(""),
    referralCode: z.string().max(40).optional().default(""),
  }),
  consents: z.object({
    terms: z.literal(true),
    authorized: z.boolean().optional(),
  }),
  next: z.string().optional(),
});

/**
 * Onboarding submit -> passwordless magic link.
 * Intake answers and referral data ride along as signup metadata; the database trigger
 * turns them into a profile and an attribution when the user is first created.
 * Existing users just get a sign-in link (metadata is ignored for them).
 */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the highlighted fields and try again." }, { status: 400 });
  }
  const b = parsed.data;
  if (b.role === "seller" && !b.consents.authorized) {
    return NextResponse.json({ error: "Confirm you're authorized to license this data." }, { status: 400 });
  }

  // Cookie (from a tracked link) beats a typed code; first touch wins.
  const cookie = await readRefCookie();
  const typed = normalizeCode(b.contact.referralCode);
  const refCode = cookie?.code ?? typed;

  const next = safeRedirectPath(b.next, b.role === "seller" ? "/sell" : "/market");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: b.contact.email.toLowerCase(),
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${env.siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
      data: {
        role: b.role,
        full_name: b.contact.name,
        company: b.contact.company,
        website: b.contact.website,
        phone: b.contact.phone,
        intake: { ...b.answers, source: b.contact.source, consented_at: new Date().toISOString() },
        ref_code: refCode ?? null,
        ref_click_id: cookie?.clickId ?? null,
        ref_first_touch_at: cookie?.firstTouchAt ?? null,
      },
    },
  });

  if (error) {
    const status = error.status === 429 ? 429 : 500;
    const message = status === 429 ? "Too many requests. Wait a minute and try again." : "We couldn't send the link. Try again.";
    return NextResponse.json({ error: message }, { status });
  }
  return NextResponse.json({ ok: true });
}
