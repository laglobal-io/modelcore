import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/supabase/server";
import { isReservedCode, normalizeCode } from "@/lib/referrals/core";

const Body = z.object({
  code: z.string(),
  type: z.enum(["sell_side", "buy_side", "talent", "general"]).default("general"),
});

/** Become a partner: claim a referral code. Idempotent; returns the existing code if already a partner. */
export async function POST(req: Request) {
  const { supabase, user } = await getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  const code = parsed.success ? normalizeCode(parsed.data.code) : null;
  if (!parsed.success || !code) {
    return NextResponse.json({ error: "Codes are 3-32 characters: letters, numbers and hyphens." }, { status: 400 });
  }
  if (isReservedCode(code)) return NextResponse.json({ error: "That code is reserved." }, { status: 400 });

  const { data, error } = await supabase.rpc("become_partner", { p_code: code, p_type: parsed.data.type });
  if (error) {
    const taken = error.code === "23505";
    return NextResponse.json({ error: taken ? "That code is taken. Try another." : error.message }, { status: taken ? 409 : 400 });
  }
  return NextResponse.json({ partner: data });
}
