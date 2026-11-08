import { test } from "node:test";
import assert from "node:assert/strict";
import {
  safeFileName, checkFile, storagePath, checkExternalUrl, isExpiryDays, isSha256, formatBytes,
  contentDisposition, sqlErrorStatus, MAX_FILES_PER_SAMPLE, MAX_FILE_BYTES,
} from "./core.ts";

test("safeFileName strips paths and odd characters", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("C:\\Users\\x\\calls 2024.jsonl"), "calls_2024.jsonl");
  assert.equal(safeFileName("..hidden"), "hidden");
  assert.equal(safeFileName("résumé$%.csv"), "resume__.csv");
  assert.equal(safeFileName(""), null);
  assert.equal(safeFileName(42), null);
});

test("checkFile enforces limits", () => {
  const none = { count: 0, bytes: 0 };
  assert.deepEqual(checkFile({ name: "a.jsonl", size: 10 }, none), { ok: true, name: "a.jsonl" });
  assert.equal(checkFile({ name: "a.jsonl", size: 0 }, none).ok, false);
  assert.equal(checkFile({ name: "a.jsonl", size: MAX_FILE_BYTES + 1 }, none).ok, false);
  assert.equal(checkFile({ name: "setup.exe", size: 10 }, none).ok, false);
  assert.equal(checkFile({ name: "a.csv", size: 10 }, { count: MAX_FILES_PER_SAMPLE, bytes: 0 }).ok, false);
  assert.equal(checkFile({ name: "a.csv", size: 2 * 1024 ** 3 }, { count: 1, bytes: 19 * 1024 ** 3 }).ok, false);
});

test("storagePath only accepts uuids", () => {
  const id = "3f1c9a7e-2b4d-4c8e-9f00-1234567890ab";
  assert.equal(storagePath(id, id, "a.csv"), `${id}/${id}/a.csv`);
  assert.throws(() => storagePath("../x", id, "a.csv"));
});

test("checkExternalUrl", () => {
  assert.equal(checkExternalUrl("https://bucket.s3.amazonaws.com/s.zip?X-Amz-Signature=1").ok, true);
  assert.equal(checkExternalUrl("http://example.com/a").ok, false);
  assert.equal(checkExternalUrl("https://user:pw@example.com/a").ok, false);
  assert.equal(checkExternalUrl("https://localhost/a").ok, false);
  assert.equal(checkExternalUrl("https://10.0.0.5/a").ok, false);
  assert.equal(checkExternalUrl("https://intranet/a").ok, false);
  assert.equal(checkExternalUrl("javascript:alert(1)").ok, false);
  assert.equal(checkExternalUrl("").ok, false);
});

test("small validators and formatting", () => {
  assert.ok(isExpiryDays(14) && isExpiryDays("7") && !isExpiryDays(90));
  assert.ok(isSha256("a".repeat(64)) && !isSha256("A".repeat(64)) && !isSha256("abc"));
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5.0 GB");
  assert.match(contentDisposition('calls "2024".csv'), /filename="calls _2024_.csv"/);
  assert.equal(sqlErrorStatus("42501"), 403);
  assert.equal(sqlErrorStatus("22023"), 400);
  assert.equal(sqlErrorStatus(undefined), 500);
});
