"use client";
import { createBrowserClient } from "@supabase/ssr";
import { SAMPLE_BUCKET } from "./core";

const HASH_LIMIT = 512 * 1024 ** 2; // hash in the browser up to 512 MB; larger files skip the checksum

async function sha256Hex(file: File): Promise<string | undefined> {
  if (file.size > HASH_LIMIT || !globalThis.crypto?.subtle) return undefined;
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Something went wrong.");
  return json as T;
}

/**
 * Seller-side upload of one sample file:
 *   1. ask the server for a signed upload URL (validates size, type and limits)
 *   2. upload the bytes straight to Supabase Storage
 *   3. tell the server it's done so it verifies the object and records the size
 */
export async function uploadSampleFile(sampleId: string, file: File): Promise<{ fileId: string; sha256?: string }> {
  const sha256 = await sha256Hex(file);
  const start = await post<{ fileId: string; path: string; token: string }>(`/api/samples/${sampleId}/files`, {
    name: file.name, size: file.size, contentType: file.type, sha256,
  });
  const supabase = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { error } = await supabase.storage.from(SAMPLE_BUCKET).uploadToSignedUrl(start.path, start.token, file, {
    contentType: file.type || "application/octet-stream",
  });
  if (error) throw new Error(`Upload failed for ${file.name}. Try again.`);
  await post(`/api/samples/${sampleId}/files/${start.fileId}/complete`);
  return { fileId: start.fileId, sha256 };
}

export const shareSample = (sampleId: string, body: unknown) => post<{ expiresAt: string }>(`/api/samples/${sampleId}/share`, body);
export const sampleAction = (sampleId: string, action: "decline" | "revoke" | "review" | "confirm-deletion", body?: unknown) =>
  post(`/api/samples/${sampleId}/${action}`, body);
/** Buyers download through this URL; the server logs the access and redirects to a short-lived link. */
export const sampleDownloadUrl = (sampleId: string, fileId?: string) =>
  `/api/samples/${sampleId}/download${fileId ? `?file=${encodeURIComponent(fileId)}` : ""}`;
