import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SAMPLE_BUCKET } from "@/lib/samples/core";
import { bad } from "@/lib/samples/server";

/** Seller removes a file before sharing. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await params;
  const { supabase, user } = await getUser();
  if (!user) return bad("Sign in first.", 401);
  const { data: sample } = await supabase.from("sample_requests").select("seller_id, status").eq("id", id).maybeSingle();
  if (!sample || sample.seller_id !== user.id || sample.status !== "requested") return bad("Can't remove files now.", 409);

  const db = createAdminClient();
  const { data: file } = await db.from("sample_files").select("storage_path").eq("id", fileId).eq("sample_id", id).maybeSingle();
  if (!file) return bad("File not found.", 404);
  await db.storage.from(SAMPLE_BUCKET).remove([file.storage_path]);
  await db.from("sample_files").delete().eq("id", fileId);
  return NextResponse.json({ ok: true });
}
