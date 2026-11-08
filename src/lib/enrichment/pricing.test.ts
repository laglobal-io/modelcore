import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichmentPriceCents, MIN_MARKUP_BPS } from "./pricing.ts";

test("enrichment price adds at least 12%", () => {
  assert.equal(enrichmentPriceCents(1_000_000, 1200), 1_120_000);
  assert.equal(enrichmentPriceCents(1_000_000), 1_150_000);
  assert.equal(enrichmentPriceCents(999, 1200), 999 + 120); // rounds the markup up
  assert.throws(() => enrichmentPriceCents(1000, MIN_MARKUP_BPS - 1));
  assert.throws(() => enrichmentPriceCents(-1));
});
