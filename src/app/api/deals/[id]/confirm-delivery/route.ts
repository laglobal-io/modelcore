import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { sellerNetCents } from "@/lib/referrals/core";

/**
 * Buyer confirms delivery -> escrow releases.
 *   1. Transfer (amount - platform fee) from the platform to the seller's Connect account
 *   2. Mark the deal 'released'; the database trigger creates partner commissions
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Read through RLS so only a party to the deal gets this far.
  const { data: deal } = await supabase
    .from("deals")
    .select("id, buyer_id, seller_id, amount_cents, currency, platform_fee_bps, status, stripe_payment_intent_id")
    .eq("id", id)
    .maybeSingle();
  if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
  if (deal.buyer_id !== user.id) return NextResponse.json({ error: "Only the buyer can confirm delivery." }, { status: 403 });
  if (deal.status === "released") return NextResponse.json({ ok: true, alreadyReleased: true });
  if (!["escrow_funded", "delivered"].includes(deal.status)) {
    return NextResponse.json({ error: "Escrow isn't funded yet." }, { status: 409 });
  }

  const db = createAdminClient();
  const { data: seller } = await db.from("profiles").select("stripe_account_id").eq("id", deal.seller_id).single();
  if (!seller?.stripe_account_id) {
    return NextResponse.json({ error: "The seller hasn't finished payout setup. We've notified them." }, { status: 409 });
  }

  const pi = await stripe().paymentIntents.retrieve(deal.stripe_payment_intent_id as string);
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;

  const transfer = await stripe().transfers.create(
    {
      amount: sellerNetCents(Number(deal.amount_cents), deal.platform_fee_bps),
      currency: deal.currency,
      destination: seller.stripe_account_id,
      transfer_group: `deal_${deal.id}`,
      ...(chargeId ? { source_transaction: chargeId } : {}),
      metadata: { deal_id: deal.id, kind: "seller_release" },
    },
    { idempotencyKey: `release-${deal.id}` },
  );

  const { error } = await db
    .from("deals")
    .update({ status: "released", released_at: new Date().toISOString(), delivered_at: new Date().toISOString(), stripe_transfer_id: transfer.id })
    .eq("id", deal.id)
    .in("status", ["escrow_funded", "delivered"]);
  if (error) return NextResponse.json({ error: "Released funds but couldn't update the deal. Support has been alerted." }, { status: 500 });

  return NextResponse.json({ ok: true, transferId: transfer.id });
}
