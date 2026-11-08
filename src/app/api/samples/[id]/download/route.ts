import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, hashIp } from "@/lib/referrals/server";
import { SAMPLE_BUCKET, SIGNED_DOWNLOAD_TTL_SECONDS } from "@/lib/samples/core";
import { bad, sqlError } from "@/lib/samples/server";

export const dynamic = "force-dynamic";

/**
 * Buyer opens a sample file (?file=<id>) or the seller's link.
 * The database authorizes and logs the access (buyer only, not expired or revoked, under the
 * per-file download limit). We then redirect to a signed URL that lives 5 minutes, so a copied
 * link stops working almost immediately.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fileId = new URL(req.url).searchParams.get("file");
  const { supabase, user } = await getUser();
  if (!user) return bad("Sign in first.", 401);

  const { data, error } = await supabase.rpc("authorize_sample_access", {
    p_sample: id,
    p_file: fileId,
    p_ip_hash: hashIp(clientIp(req.headers)),
    p_ua: req.headers.get("user-agent") ?? "",
  });
  if (error) return sqlError(error);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return bad("Not available.", 404);

  if (row.kind === "link") return NextResponse.redirect(row.target, 302);

  const { data: signed, error: sErr } = await createAdminClient()
    .storage.from(SAMPLE_BUCKET)
    .createSignedUrl(row.target, SIGNED_DOWNLOAD_TTL_SECONDS, { download: row.file_name });
  if (sErr || !signed) return bad("Couldn't create the download link. Try again.", 500);

  const res = NextResponse.redirect(signed.signedUrl, 302);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
