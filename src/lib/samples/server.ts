import "server-only";
import { NextResponse } from "next/server";
import { sqlErrorStatus } from "./core";

type PgError = { code?: string; message?: string } | null;

/** Turns an error raised by a sample SQL function into a JSON response with a readable message. */
export function sqlError(err: PgError) {
  const status = sqlErrorStatus(err?.code);
  const message = status === 500 ? "Something went wrong. Try again." : (err?.message ?? "Not allowed.");
  return NextResponse.json({ error: message }, { status });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
