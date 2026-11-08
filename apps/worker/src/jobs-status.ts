import { schema, withWorker } from "@jadwalin/db";
import { sql } from "drizzle-orm";
import type pg from "pg";

/** Catat hasil terakhir pekerjaan latar (dibaca endpoint kesiapan untuk pemantauan). */
export async function recordJob(pool: pg.Pool, job: string, result: { ok: true; detail?: Record<string, unknown> } | { ok: false; error: string }): Promise<void> {
  const now = new Date();
  await withWorker(pool, (db) =>
    db
      .insert(schema.jobStatus)
      .values(result.ok ? { job, lastOkAt: now, lastDetail: result.detail ?? null, updatedAt: now } : { job, lastFailedAt: now, lastError: result.error.slice(0, 1000), updatedAt: now })
      .onConflictDoUpdate({
        target: schema.jobStatus.job,
        set: result.ok
          ? { lastOkAt: now, lastDetail: result.detail ?? null, updatedAt: now }
          : { lastFailedAt: now, lastError: sql`${result.error.slice(0, 1000)}`, updatedAt: now },
      }),
  );
}
