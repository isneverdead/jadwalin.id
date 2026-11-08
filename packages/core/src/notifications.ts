import { schema, withWorker, type Db } from "@jadwalin/db";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { renderEmail, SENSITIVE_TEMPLATES, type EmailTemplate } from "./email-templates";
import type { EmailSender } from "./email";
import { getLimits } from "./entitlements";
import { AppError } from "./errors";
import { localDateOf, TIMEZONE_OFFSET_MIN } from "./slots";

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_ATTEMPTS = 5;
const STUCK_AFTER_MS = 10 * 60_000;

/** Jeda sebelum percobaan ke-n+1 setelah percobaan ke-n gagal. */
export function backoffMs(attempt: number): number {
  const steps = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1]!;
}

export interface EnqueueEmailInput {
  /** Null = email sistem (tidak dihitung ke kuota workspace); wajib memakai koneksi worker. */
  workspaceId: string | null;
  to: string;
  template: EmailTemplate;
  payload: Record<string, unknown>;
  sendAt?: Date;
  /** Kunci idempoten: enqueue ulang dengan kunci sama tidak membuat baris atau memakai kuota lagi. */
  dedupeKey?: string;
  now?: Date;
}

export type EnqueueResult = { status: "queued" | "skipped_quota" | "duplicate"; id: string | null };

/**
 * Outbox transaksional: dipanggil di dalam transaksi yang sama dengan perubahan bisnis, sehingga pesan
 * hanya ada jika perubahannya ikut commit. Kuota dicek dan dikurangi di transaksi ini juga (aturan #11).
 */
export async function enqueueEmail(db: Db, input: EnqueueEmailInput): Promise<EnqueueResult> {
  const to = input.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw new AppError("invalid_input", "Alamat email tidak valid.");
  const now = input.now ?? new Date();
  const dedupeKey = input.dedupeKey ? `${input.workspaceId ?? "sys"}:${input.dedupeKey}` : null;

  const [row] = await db
    .insert(schema.notificationOutbox)
    .values({ workspaceId: input.workspaceId, channel: "email", recipient: to, template: input.template, payload: input.payload, sendAt: input.sendAt ?? now, dedupeKey })
    .onConflictDoNothing({ target: schema.notificationOutbox.dedupeKey })
    .returning({ id: schema.notificationOutbox.id });
  if (!row) return { status: "duplicate", id: null };

  if (input.workspaceId) {
    const period = localDateOf(now.getTime(), TIMEZONE_OFFSET_MIN["Asia/Jakarta"]).slice(0, 7);
    const { emailPerMonth } = await getLimits(input.workspaceId);
    const reserved = await db.execute<{ used: number }>(sql`
      INSERT INTO notification_quota_usage (workspace_id, period, channel, used, limit_count)
      VALUES (${input.workspaceId}, ${period}, 'email', 1, ${emailPerMonth})
      ON CONFLICT (workspace_id, period, channel) DO UPDATE
        SET used = notification_quota_usage.used + 1, limit_count = EXCLUDED.limit_count
        WHERE notification_quota_usage.used + 1 <= EXCLUDED.limit_count
      RETURNING used`);
    if (reserved.rows.length === 0) {
      await db.update(schema.notificationOutbox).set({ status: "skipped_quota", lastError: "Kuota email bulanan habis" }).where(eq(schema.notificationOutbox.id, row.id));
      return { status: "skipped_quota", id: row.id };
    }
  }
  return { status: "queued", id: row.id };
}

/** Email sistem (verifikasi, reset sandi): tanpa workspace, lewat role worker. */
export async function enqueueSystemEmail(pool: pg.Pool, input: Omit<EnqueueEmailInput, "workspaceId">): Promise<EnqueueResult> {
  return withWorker(pool, (db) => enqueueEmail(db, { ...input, workspaceId: null }));
}

export interface DispatchOptions {
  sender: EmailSender;
  from: string;
  now?: Date;
  limit?: number;
  maxAttempts?: number;
}

export interface DispatchStats {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

type ClaimedRow = {
  id: string;
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  attempts: number;
};

/**
 * Worker: klaim pesan jatuh tempo (FOR UPDATE SKIP LOCKED → dua worker tidak pernah mengambil pesan yang sama),
 * kirim, lalu catat hasilnya. Semantik at-least-once: bila proses mati antara kirim dan catat,
 * pesan yang macet di `sending` diambil ulang setelah 10 menit.
 */
export async function dispatchDue(pool: pg.Pool, opts: DispatchOptions): Promise<DispatchStats> {
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);

  const claimed = await withWorker(pool, async (db) => {
    const res = await db.execute<ClaimedRow>(sql`
      WITH due AS (
        SELECT id FROM notification_outbox
        WHERE channel = 'email'
          AND ((status = 'queued' AND send_at <= ${now.toISOString()}::timestamptz)
            OR (status = 'sending' AND locked_at < ${stuckBefore.toISOString()}::timestamptz))
        ORDER BY send_at
        LIMIT ${opts.limit ?? 20}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE notification_outbox o
      SET status = 'sending', locked_at = ${now.toISOString()}::timestamptz, attempts = o.attempts + 1
      FROM due WHERE o.id = due.id
      RETURNING o.id, o.recipient, o.template, o.payload, o.attempts`);
    return res.rows;
  });

  const stats: DispatchStats = { claimed: claimed.length, sent: 0, retried: 0, failed: 0 };
  for (const row of claimed) {
    try {
      const rendered = renderEmail(row.template, row.payload);
      const result = await opts.sender.send({ from: opts.from, to: row.recipient, outboxId: row.id, ...rendered });
      await withWorker(pool, (db) =>
        db.update(schema.notificationOutbox)
          .set({
            status: "sent",
            sentAt: now,
            lockedAt: null,
            lastError: null,
            providerMessageId: result.messageId,
            ...(SENSITIVE_TEMPLATES.has(row.template) ? { payload: { redacted: true } } : {}),
          })
          .where(sql`${schema.notificationOutbox.id} = ${row.id} AND ${schema.notificationOutbox.status} = 'sending'`),
      );
      stats.sent++;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const final = row.attempts >= maxAttempts;
      await withWorker(pool, (db) =>
        db.update(schema.notificationOutbox)
          .set(final ? { status: "failed", lockedAt: null, lastError: message } : { status: "queued", lockedAt: null, lastError: message, sendAt: new Date(now.getTime() + backoffMs(row.attempts)) })
          .where(sql`${schema.notificationOutbox.id} = ${row.id} AND ${schema.notificationOutbox.status} = 'sending'`),
      );
      if (final) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}
