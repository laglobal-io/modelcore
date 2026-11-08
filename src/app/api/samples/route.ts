import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/supabase/server";
import { bad, readJson, sqlError } from "@/lib/samples/server";

const Body = z.object({
  listingId: z.string().uuid(),
  acceptTerms: z.literal(true),
  request: z.object({
    size: z.string().max(80),
    slice: z.string().max(300).optional(),
    fields: z.string().max(300).optional(),
    purpose: z.array(z.string().max(40)).max(8).optional(),
    neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().max(1000).optional(),
  }),
});

/** Buyer requests a sample. The SQL function checks the NDA is signed by both sides. */
export async function POST(req: Request) {
  const { supabase, user } = await getUser();
  if (!user) return bad("Sign in first.", 401);
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return bad("Check the request fields and accept the evaluation-only terms.");

  const { data, error } = await supabase.rpc("request_sample", {
    p_listing: parsed.data.listingId,
    p_request: parsed.data.request,
    p_accept_terms: true,
  });
  if (error) return sqlError(error);
  return NextResponse.json({ ok: true, sampleId: data });
}
