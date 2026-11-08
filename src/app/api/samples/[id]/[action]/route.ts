import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkExternalUrl, isExpiryDays, SAMPLE_BUCKET } from "@/lib/samples/core";
import { bad, readJson, sqlError } from "@/lib/samples/server";

const Share = z.object({
  method: z.enum(["upload", "external_link"]),
  externalUrl: z.string().max(2048).optional(),
  expiresDays: z.number(),
  details: z
    .object({
      what: z.string().max(300).optional(),
      format: z.string().max(200).optional(),
      canary: z.boolean().optional(),
      deidentified: z.boolean().optional(),
      note: z.string().max(1000).optional(),
    })
    .default({}),
});
const Review = z.object({
  verdict: z.enum(["ready", "again", "nofit"]),
  feedback: z.object({
    dims: z.record(z.string().max(40), z.number().int().min(1).max(5)),
    issues: z.array(z.string().max(60)).max(12).default([]),
    notes: z.string().max(2000).default(""),
  }),
});

/**
 * Sample state changes. Each one is a SQL function that checks the caller's role and the
 * sample's state, so this route only parses input and handles storage side effects.
 *   share | decline            seller
 *   revoke                     seller (also deletes uploaded files right away)
 *   review | confirm-deletion  buyer
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  const { supabase, user } = await getUser();
  if (!user) return bad("Sign in first.", 401);
  const body = (await readJson(req)) ?? {};

  switch (action) {
    case "share": {
      const p = Share.safeParse(body);
      if (!p.success || !isExpiryDays(p.data.expiresDays)) return bad("Choose how to share and when access expires.");
      let url: string | null = null;
      if (p.data.method === "external_link") {
        const c = checkExternalUrl(p.data.externalUrl);
        if (!c.ok) return bad(c.error);
        url = c.url;
      }
      const { data, error } = await supabase.rpc("share_sample", {
        p_sample: id, p_method: p.data.method, p_external_url: url, p_expires_days: p.data.expiresDays, p_details: p.data.details,
      });
      if (error) return sqlError(error);
      return NextResponse.json({ ok: true, expiresAt: data });
    }
    case "decline": {
      const reason = typeof (body as { reason?: unknown }).reason === "string" ? (body as { reason: string }).reason : "";
      const { error } = await supabase.rpc("decline_sample", { p_sample: id, p_reason: reason });
      return error ? sqlError(error) : NextResponse.json({ ok: true });
    }
    case "revoke": {
      const { error } = await supabase.rpc("revoke_sample", { p_sample: id });
      if (error) return sqlError(error);
      await purgeNow(id);
      return NextResponse.json({ ok: true });
    }
    case "review": {
      const p = Review.safeParse(body);
      if (!p.success) return bad("Rate all five areas from 1 to 5 and pick a verdict.");
      const dims = p.data.feedback.dims;
      const vals = Object.values(dims);
      const avg = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
      const { data, error } = await supabase.rpc("review_sample", {
        p_sample: id, p_feedback: { ...p.data.feedback, avg }, p_verdict: p.data.verdict,
      });
      if (error) return sqlError(error);
      if (p.data.verdict !== "ready") await purgeNow(id);
      return NextResponse.json({ ok: true, nextSampleId: data ?? null });
    }
    case "confirm-deletion": {
      const { error } = await supabase.rpc("confirm_sample_deletion", { p_sample: id });
      return error ? sqlError(error) : NextResponse.json({ ok: true });
    }
    default:
      return bad("Unknown action.", 404);
  }
}

/** Deletes a sample's stored files once access has ended, instead of waiting for the nightly cron. */
async function purgeNow(sampleId: string) {
  const db = createAdminClient();
  const { data: files } = await db.from("sample_files").select("id, storage_path").eq("sample_id", sampleId).is("purged_at", null);
  if (!files?.length) return;
  const { error } = await db.storage.from(SAMPLE_BUCKET).remove(files.map((f) => f.storage_path));
  if (!error) await db.rpc("mark_sample_files_purged", { p_files: files.map((f) => f.id) });
}
