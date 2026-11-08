// Enrichment pricing. Mirrors enrichment_orders.price_cents in SQL: price = cost + ceil(cost * markup).
// Markup is internal: buyers only ever see the final price.

export const MIN_MARKUP_BPS = 1200;     // 12% floor, enforced again in the database
export const DEFAULT_MARKUP_BPS = 1500; // 15% unless set per quote

export function enrichmentPriceCents(costCents: number, markupBps = DEFAULT_MARKUP_BPS): number {
  if (!Number.isInteger(costCents) || costCents < 0) throw new Error("cost must be a non-negative integer of cents");
  if (!Number.isInteger(markupBps) || markupBps < MIN_MARKUP_BPS) {
    throw new Error(`markup must be at least ${MIN_MARKUP_BPS} bps`);
  }
  return costCents + Math.ceil((costCents * markupBps) / 10000);
}
