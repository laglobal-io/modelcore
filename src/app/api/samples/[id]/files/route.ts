import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkFile, isSha256, SAMPLE_BUCKET, storagePath } from "@/lib/samples/core";
import { bad, readJson } from "@/lib/samples/server";

/**
 * Seller starts a file upload. Returns a signed upload URL scoped to one object in the private
 * bucket; the browser uploads straight to Supabase Storage (bytes never pass through Vercel).
 * The file only counts once /complete verifies the object exists.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await getUser();
  if (!user) return bad("Sign in first.", 401);

  // RLS on sample_requests only returns rows to the seller (buyers read through the view).
  const { data: sample } = await supabase
    .from("sample_requests")
    .select("id, seller_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!sample || sample.seller_id !== user.id) return bad("Sample not found.", 404);
  if (sample.status !== "requested") return bad("This sample has already been shared or closed.", 409);

  const body = await readJson<{ name?: unknown; size?: unknown; contentType?: unknown; sha256?: unknown }>(req);
  if (!body) return bad("Send the file name and size.");

  const db = createAdminClient();
  const { data: existing } = await db
    .from("sample_files")
    .select("size_bytes")
    .eq("sample_id", id)
    .is("purged_at", null);
  const check = checkFile(
    { name: body.name, size: body.size },
    { count: existing?.length ?? 0, bytes: (existing ?? []).reduce((a, f) => a + Number(f.size_bytes), 0) },
  );
  if (!check.ok) return bad(check.error);

  const fileId = randomUUID();
  const path = storagePath(id, fileId, check.name);
  const { error: insErr } = await db.from("sample_files").insert({
    id: fileId,
    sample_id: id,
    storage_path: path,
    file_name: check.name,
    size_bytes: Number(body.size),
    content_type: typeof body.contentType === "string" ? body.contentType.slice(0, 120) : null,
    sha256: isSha256(body.sha256) ? body.sha256 : null,
  });
  if (insErr) return bad("Couldn't start the upload. Try again.", 500);

  const { data: signed, error } = await db.storage.from(SAMPLE_BUCKET).createSignedUploadUrl(path);
  if (error || !signed) return bad("Couldn't start the upload. Try again.", 500);

  return NextResponse.json({ fileId, path: signed.path, token: signed.token, signedUrl: signed.signedUrl });
}
