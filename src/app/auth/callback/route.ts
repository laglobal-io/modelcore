import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/referrals/core";

/** Magic-link landing. Supports the PKCE `code` flow and the `token_hash` email template flow. */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const next = safeRedirectPath(url.searchParams.get("next"), "/market");
  const supabase = await createClient();

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  let ok = false;
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && type) {
    ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  }

  const dest = ok ? next : `/join?error=link_expired&next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(new URL(dest, url.origin));
}
