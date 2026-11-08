import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";

/**
 * Starts (or resumes) Stripe Express onboarding so a partner can receive payouts.
 * payouts_enabled flips to true from the account.updated webhook.
 */
export async function POST() {
  const { user } = await getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const db = createAdminClient();
  const { data: partner } = await db
    .from("partners")
    .select("id, stripe_account_id")
    .eq("profile_id", user.id)
    .maybeSingle();
  if (!partner) return NextResponse.json({ error: "Claim a referral code first." }, { status: 404 });

  let accountId = partner.stripe_account_id as string | null;
  if (!accountId) {
    const account = await stripe().accounts.create(
      {
        type: "express",
        email: user.email ?? undefined,
        capabilities: { transfers: { requested: true } },
        metadata: { partner_id: partner.id, profile_id: user.id },
      },
      { idempotencyKey: `partner-account-${partner.id}` },
    );
    accountId = account.id;
    await db.from("partners").update({ stripe_account_id: accountId }).eq("id", partner.id);
  }

  const link = await stripe().accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${env.siteUrl()}/partners/dashboard?stripe=refresh`,
    return_url: `${env.siteUrl()}/partners/dashboard?stripe=done`,
  });
  return NextResponse.json({ url: link.url });
}
