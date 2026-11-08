import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCode, isReservedCode, suggestCode, safeRedirectPath, platformFeeCents, commissionCents,
  sellerNetCents, serializeRefCookie, parseRefCookie, isBot, formatUsd,
} from "./core.ts";

test("normalizeCode", () => {
  assert.equal(normalizeCode("  VCFund "), "vcfund");
  assert.equal(normalizeCode("ab"), null);
  assert.equal(normalizeCode("-abc"), null);
  assert.equal(normalizeCode("a!bc"), null);
  assert.equal(normalizeCode("x".repeat(33)), null);
  assert.equal(normalizeCode(42), null);
});

test("reserved and suggested codes", () => {
  assert.ok(isReservedCode("Admin"));
  assert.equal(suggestCode("Michael Levay"), "michael-levay");
  assert.equal(suggestCode("José Núñez"), "jose-nunez");
  assert.ok(normalizeCode(suggestCode("Al")));
});

test("safeRedirectPath blocks open redirects", () => {
  assert.equal(safeRedirectPath("/partners/dashboard?x=1"), "/partners/dashboard?x=1");
  assert.equal(safeRedirectPath("//evil.com"), "/");
  assert.equal(safeRedirectPath("/\\evil.com"), "/");
  assert.equal(safeRedirectPath("https://evil.com"), "/");
  assert.equal(safeRedirectPath(undefined, "/market"), "/market");
});

test("fee math matches SQL", () => {
  assert.equal(platformFeeCents(25_000_000, 1000), 2_500_000);
  assert.equal(commissionCents(2_500_000, 2500), 625_000);
  assert.equal(platformFeeCents(3_333_333, 1000), 333_333);
  assert.equal(commissionCents(333_333, 2500), 83_333);
  assert.equal(sellerNetCents(10_000_000, 1000), 9_000_000);
});

test("ref cookie round trip", () => {
  const v = { code: "vcfund", clickId: 12, firstTouchAt: "2026-11-01T00:00:00.000Z" };
  assert.deepEqual(parseRefCookie(serializeRefCookie(v)), v);
  assert.deepEqual(parseRefCookie("vcfund||2026-11-01T00:00:00.000Z")?.clickId, null);
  assert.equal(parseRefCookie("bad code|1|2026-11-01"), null);
  assert.equal(parseRefCookie("vcfund|1|not-a-date"), null);
  assert.equal(parseRefCookie(undefined), null);
});

test("isBot and formatting", () => {
  assert.ok(isBot("Slackbot-LinkExpanding 1.0"));
  assert.ok(isBot(""));
  assert.ok(!isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"));
  assert.equal(formatUsd(625_000), "$6,250");
  assert.equal(formatUsd(83_333), "$833.33");
});
