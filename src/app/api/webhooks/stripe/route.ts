import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Stripe events that move deals and partner payout state.
 * Configure in Stripe for both the platform and connected accounts:
 *   payment_intent.succeeded, charge.refunded, account.updated
 */
export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(body, sig ?? "", env.stripeWebhookSecret());
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const db = createAdminClient();

  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object;
      const dealId = pi.metadata?.deal_id;
      if (dealId) {
        await db
          .from("deals")
          .update({ status: "escrow_funded", escrow_funded_at: new Date().toISOString(), stripe_payment_intent_id: pi.id })
          .eq("id", dealId)
          .in("status", ["offered", "accepted"]);
      }
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object;
      const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      // Full refunds only. The deals trigger voids any unpaid partner commissions.
      if (piId && charge.amount_refunded >= charge.amount) {
        await db.from("deals").update({ status: "refunded" }).eq("stripe_payment_intent_id", piId);
      }
      break;
    }
    case "account.updated": {
      const account = event.data.object;
      await db
        .from("partners")
        .update({ payouts_enabled: Boolean(account.payouts_enabled) })
        .eq("stripe_account_id", account.id);
      break;
    }
    default:
      break;
  }
  return NextResponse.json({ received: true });
}
