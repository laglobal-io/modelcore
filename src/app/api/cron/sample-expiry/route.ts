import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { SAMPLE_BUCKET } from "@/lib/samples/core";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Hourly (vercel.json): ends samples whose access window has passed, then deletes stored files
 * for every ended sample and for uploads abandoned for over a day.
 */
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret()}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const { data: expired, error } = await db.rpc("expire_samples");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let purged = 0;
  for (let batch = 0; batch < 10; batch++) {
    const { data: files } = await db.rpc("sample_files_to_purge", { p_limit: 500 });
    const list = (files ?? []) as { file_id: string; storage_path: string }[];
    if (!list.length) break;
    const { error: rmErr } = await db.storage.from(SAMPLE_BUCKET).remove(list.map((f) => f.storage_path));
    if (rmErr) return NextResponse.json({ expired, purged, error: rmErr.message }, { status: 500 });
    await db.rpc("mark_sample_files_purged", { p_files: list.map((f) => f.file_id) });
    purged += list.length;
  }
  return NextResponse.json({ ok: true, expired, purged });
}
