import type { Metadata } from "next";
import { readRefCookie } from "@/lib/referrals/server";
import { safeRedirectPath } from "@/lib/referrals/core";
import Onboarding from "./onboarding";

export const metadata: Metadata = { title: "Get started", robots: { index: false } };

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; next?: string; error?: string; mode?: string }>;
}) {
  const sp = await searchParams;
  const ref = await readRefCookie();
  const role = sp.role === "seller" || sp.role === "buyer" ? sp.role : null;
  return (
    <Onboarding
      initialRole={role}
      next={sp.next ? safeRedirectPath(sp.next) : null}
      linkExpired={sp.error === "link_expired"}
      startInLogin={sp.mode === "login"}
      referredBy={ref?.code ?? null}
    />
  );
}
