// Pure sample-room helpers. No framework imports, so they run under `node --test`.
// Server routes use these to validate input before calling the SQL functions in
// supabase/migrations/20261108000003_samples.sql, which re-check everything.

export const SAMPLE_BUCKET = "samples";
export const MAX_FILE_BYTES = 5 * 1024 ** 3;        // matches the bucket's file_size_limit
export const MAX_SAMPLE_BYTES = 20 * 1024 ** 3;     // total per sample round
export const MAX_FILES_PER_SAMPLE = 25;
export const EXPIRY_DAYS = [7, 14, 30] as const;
export const SIGNED_DOWNLOAD_TTL_SECONDS = 300;      // each download link lives 5 minutes
export const UPLOAD_URL_TTL_HOURS = 2;               // Supabase signed upload URLs last 2 hours

const BLOCKED_EXT = new Set([
  "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "vbs", "js", "jar", "app", "dmg", "pkg", "sh", "apk", "iso", "lnk", "dll",
]);

export type ExpiryDays = (typeof EXPIRY_DAYS)[number];

/** Keeps a readable name but strips paths, control chars and anything a URL or shell might trip on. */
export function safeFileName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(-120);
  return cleaned && cleaned !== "." ? cleaned : null;
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export type FileCheck = { ok: true; name: string } | { ok: false; error: string };

/** Validates one file against limits and what is already in the sample. */
export function checkFile(
  input: { name: unknown; size: unknown },
  existing: { count: number; bytes: number },
): FileCheck {
  const name = safeFileName(input.name);
  if (!name) return { ok: false, error: "File name isn't valid." };
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: `${name} is empty.` };
  if (size > MAX_FILE_BYTES) return { ok: false, error: `${name} is over the 5 GB per-file limit. Split it, or share a link instead.` };
  if (BLOCKED_EXT.has(extensionOf(name))) return { ok: false, error: `${name} is an executable file type, which samples can't include.` };
  if (existing.count + 1 > MAX_FILES_PER_SAMPLE) return { ok: false, error: `A sample can have up to ${MAX_FILES_PER_SAMPLE} files. Zip them, or share a link.` };
  if (existing.bytes + size > MAX_SAMPLE_BYTES) return { ok: false, error: "A sample can total up to 20 GB. Share a smaller slice, or a link." };
  return { ok: true, name };
}

/** Object key inside the private bucket: <sample>/<file>/<name>. Ids are UUIDs minted by the server. */
export function storagePath(sampleId: string, fileId: string, safeName: string): string {
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(sampleId) || !uuid.test(fileId)) throw new Error("bad id");
  return `${sampleId}/${fileId}/${safeName}`;
}

/** Seller-hosted links: https only, no credentials, no local or private network hosts. */
export function checkExternalUrl(input: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "Paste the link to your sample." };
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: "That isn't a valid link." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Links must start with https://." };
  if (u.username || u.password) return { ok: false, error: "Remove the username or password from the link." };
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")
  ) {
    return { ok: false, error: "Use a public storage link (S3, GCS, Azure, Drive, Dropbox, Box)." };
  }
  return { ok: true, url: u.toString() };
}

export function isExpiryDays(v: unknown): v is ExpiryDays {
  return EXPIRY_DAYS.includes(Number(v) as ExpiryDays);
}

export function isSha256(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Content-Disposition value for a download, ASCII fallback plus RFC 5987 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Maps Postgres errors raised by the sample functions to HTTP responses. */
export function sqlErrorStatus(code: string | undefined): number {
  if (code === "28000") return 401;
  if (code === "42501") return 403;
  if (code === "22023" || code === "23505") return 400;
  return 500;
}
