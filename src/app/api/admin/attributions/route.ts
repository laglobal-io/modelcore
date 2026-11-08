import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/supabase/server";

const Body = z.object({
  email: z.string().trim().email(),
  partnerCode: z.string().trim().min(3).max(32),
  note: z.string().trim().max(500).optional(),
});

/** Admin: credit a partner for an existing member (offline intros, missed links). */
export async function POST(req: Request) {
  const { supabase, user } = await getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter the member's email and a partner code." }, { status: 400 });

  // Admin RLS lets this read any profile; non-admins only see themselves.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", parsed.data.email.toLowerCase())
    .maybeSingle();
  if (!profile) return NextResponse.json({ error: "No member with that email." }, { status: 404 });

  const { data, error } = await supabase.rpc("admin_attribute", {
    p_profile_id: profile.id,
    p_partner_code: parsed.data.partnerCode,
    p_note: parsed.data.note ?? null,
  });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "23505" ? 409 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ attribution: data });
}
