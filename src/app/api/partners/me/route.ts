import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";

/** Partner dashboard data as JSON (same read model the dashboard page renders). */
export async function GET() {
  const { supabase, user } = await getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { data, error } = await supabase.rpc("partner_dashboard");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not a partner yet." }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
