import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { safeRedirectPath } from "@/lib/referrals/core";

const Body = z.object({ email: z.string().trim().email(), next: z.string().optional() });

/** Returning members: magic link only, never creates an account (new users go through onboarding). */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });

  const supabase = await createClient();
  const next = safeRedirectPath(parsed.data.next, "/market");
  await supabase.auth.signInWithOtp({
    email: parsed.data.email.toLowerCase(),
    options: { shouldCreateUser: false, emailRedirectTo: `${env.siteUrl()}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  // Same response whether or not the account exists, so emails can't be enumerated.
  return NextResponse.json({ ok: true });
}
