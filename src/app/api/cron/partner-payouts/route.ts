import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Pays partners their approved commissions (Vercel cron, see vercel.json).
 * For each payout-ready partner: claim a batch in the database, transfer it, then mark paid or failed.
 * A failed transfer releases the batch so the next run retries it.
 */
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret()}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const { data: partners, error } = await db
    .from("partners")
    .select("id, stripe_account_id")
    .eq("status", "active")
    .eq("payouts_enabled", true)
    .not("stripe_account_id", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const results: { partnerId: string; amountCents?: number; status: string; reason?: string }[] = [];

  for (const p of partners ?? []) {
    const { data: payout } = await db.rpc("claim_partner_payout", { p_partner_id: p.id });
    if (!payout?.id) {
      results.push({ partnerId: p.id, status: "skipped" });
      continue;
    }
    try {
      const transfer = await stripe().transfers.create(
        {
          amount: Number(payout.amount_cents),
          currency: payout.currency,
          destination: p.stripe_account_id as string,
          metadata: { partner_id: p.id, payout_id: payout.id, kind: "partner_commission" },
        },
        { idempotencyKey: `partner-payout-${payout.id}` },
      );
      await db.rpc("mark_payout_paid", { p_payout_id: payout.id, p_transfer_id: transfer.id });
      results.push({ partnerId: p.id, amountCents: Number(payout.amount_cents), status: "paid" });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "transfer failed";
      await db.rpc("mark_payout_failed", { p_payout_id: payout.id, p_reason: reason });
      results.push({ partnerId: p.id, status: "failed", reason });
    }
  }

  return NextResponse.json({ ran_at: new Date().toISOString(), results });
}
