import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SAMPLE_BUCKET } from "@/lib/samples/core";
import { bad } from "@/lib/samples/server";

/** Seller finished uploading one file: confirm the object is in storage and record its real size. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params;
  const { supabase, user } = await getUser();
  if (!user) return bad("Sign in first.", 401);

  const { data: sample } = await supabase.from("sample_requests").select("seller_id, status").eq("id", id).maybeSingle();
  if (!sample || sample.seller_id !== user.id) return bad("Sample not found.", 404);
  if (sample.status !== "requested") return bad("This sample has already been shared or closed.", 409);

  const db = createAdminClient();
  const { data: file } = await db
    .from("sample_files")
    .select("id, storage_path, file_name")
    .eq("id", fileId)
    .eq("sample_id", id)
    .maybeSingle();
  if (!file) return bad("File not found.", 404);

  const folder = file.storage_path.slice(0, file.storage_path.lastIndexOf("/"));
  const { data: objects } = await db.storage.from(SAMPLE_BUCKET).list(folder, { limit: 2 });
  const obj = objects?.find((o) => o.name === file.file_name);
  const size = Number((obj?.metadata as { size?: number } | undefined)?.size ?? 0);
  if (!obj || size <= 0) return bad("The upload didn't finish. Try that file again.", 409);

  await db.from("sample_files").update({ uploaded_at: new Date().toISOString(), size_bytes: size }).eq("id", fileId);
  return NextResponse.json({ ok: true, sizeBytes: size });
}
