// Pure referral helpers. No framework imports, so they run under `node --test`.
// Fee math mirrors public.platform_fee_cents / public.commission_cents in SQL.

export const REF_COOKIE = "mc_ref";
export const VISITOR_COOKIE = "mc_vid";
export const REF_COOKIE_MAX_AGE_DAYS = 90; // cookie life; the attribution window itself is 24 months from first touch
export const VISITOR_COOKIE_MAX_AGE_DAYS = 730;

const CODE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const RESERVED = new Set(["admin", "modelcore", "api", "www", "support", "help", "partners", "r"]);

/** Lowercase + trim; returns null if not a valid partner code. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toLowerCase();
  return CODE_RE.test(code) ? code : null;
}

export function isReservedCode(code: string): boolean {
  return RESERVED.has(code.toLowerCase());
}

/** Suggest a code from a name, e.g. "Michael Levay" -> "michael-levay". */
export function suggestCode(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base.length >= 3 ? base : `${base || "partner"}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Only same-site relative paths; blocks protocol-relative and absolute URLs. */
export function safeRedirectPath(to: unknown, fallback = "/"): string {
  if (typeof to !== "string" || !to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\")) return fallback;
  try {
    const u = new URL(to, "https://x.invalid");
    return u.origin === "https://x.invalid" ? u.pathname + u.search + u.hash : fallback;
  } catch {
    return fallback;
  }
}

/** Fee rounds half-up to the cent. */
export function platformFeeCents(amountCents: number, feeBps: number): number {
  return Math.round((amountCents * feeBps) / 10000);
}

/** Partner commission rounds down to the cent. */
export function commissionCents(feeCents: number, shareBps: number): number {
  return Math.floor((feeCents * shareBps) / 10000);
}

export function sellerNetCents(amountCents: number, feeBps: number): number {
  return amountCents - platformFeeCents(amountCents, feeBps);
}

export type RefCookie = { code: string; clickId: number | null; firstTouchAt: string };

export function serializeRefCookie(v: RefCookie): string {
  return [v.code, v.clickId ?? "", v.firstTouchAt].join("|");
}

export function parseRefCookie(raw: string | undefined | null): RefCookie | null {
  if (!raw) return null;
  const [code, click, ts] = raw.split("|");
  const c = normalizeCode(code);
  const t = ts ? new Date(ts) : null;
  if (!c || !t || Number.isNaN(t.getTime())) return null;
  const clickId = click && /^\d+$/.test(click) ? Number(click) : null;
  return { code: c, clickId, firstTouchAt: t.toISOString() };
}

const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|quora link|whatsapp|slackbot|discordbot|linkedinbot|headless/i;
export function isBot(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_RE.test(userAgent);
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}
