import { cleanupPendingFiles, cleanupRateCounters, dispatchDue, reconcilePayments, type EmailSender, type PaymentDeps, type StorageAdapter } from "@jadwalin/core";
import type pg from "pg";
import type { BackupEnv } from "@jadwalin/config";
import { recordJob } from "./jobs-status";
import { pruneBackupsJob, runBackupJob, verifyBackupJob } from "./backup/jobs";

export const JOBS = {
  dispatchEmail: "dispatch-email",
  cleanupFiles: "cleanup-files",
  cleanupRateCounters: "cleanup-rate-counters",
  heartbeat: "heartbeat",
  reconcilePayments: "reconcile-payments",
  backup: "backup-database",
  backupVerify: "backup-verify",
  backupPrune: "backup-prune",
} as const;

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface WorkerDeps {
  pool: pg.Pool;
  sender: EmailSender;
  from: string;
  /** Kosong bila penyimpanan belum dikonfigurasi: job pembersihan dilewati. */
  storage?: StorageAdapter;
  log: Logger;
  /** Null = backup dimatikan (BACKUP_ENABLED bukan true). */
  backup?: { env: BackupEnv; databaseUrl: string } | null;
  /** Null = pembayaran dimatikan (PAYMENT_PROVIDER kosong): rekonsiliasi dilewati. */
  payments?: PaymentDeps | null;
}

const BATCH = 50;
const MAX_BATCHES_PER_RUN = 20;

/**
 * Semua kerja nyata ada di `core` (aman dijalankan bersamaan lewat FOR UPDATE SKIP LOCKED);
 * BullMQ hanya memberi jadwal, satu eksekusi aktif per job, dan visibilitas antrian.
 */
export function createProcessor(deps: WorkerDeps) {
  return async (job: { name: string }): Promise<Record<string, number>> => {
    switch (job.name) {
      case JOBS.dispatchEmail: {
        const total = { claimed: 0, sent: 0, retried: 0, failed: 0 };
        for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
          const s = await dispatchDue(deps.pool, { sender: deps.sender, from: deps.from, limit: BATCH });
          total.claimed += s.claimed;
          total.sent += s.sent;
          total.retried += s.retried;
          total.failed += s.failed;
          if (s.claimed < BATCH) break;
        }
        if (total.claimed > 0) deps.log.info(total, "email dispatched");
        return total;
      }
      case JOBS.cleanupFiles: {
        if (!deps.storage) {
          deps.log.warn({}, "penyimpanan belum dikonfigurasi, pembersihan berkas dilewati");
          return { removed: 0 };
        }
        const removed = await cleanupPendingFiles(deps.pool, deps.storage);
        if (removed > 0) deps.log.info({ removed }, "unggahan yatim dibersihkan");
        return { removed };
      }
      case JOBS.cleanupRateCounters: {
        const removed = await cleanupRateCounters(deps.pool);
        if (removed > 0) deps.log.info({ removed }, "penghitung laju kedaluwarsa dibersihkan");
        return { removed };
      }
      case JOBS.reconcilePayments: {
        if (!deps.payments) return { skipped: 1 };
        const r = await reconcilePayments(deps.payments);
        if (r.changed > 0) deps.log.info(r, "pembayaran direkonsiliasi");
        return { ...r };
      }
      case JOBS.heartbeat: {
        await recordJob(deps.pool, "worker_heartbeat", { ok: true });
        return { ok: 1 };
      }
      case JOBS.backup:
      case JOBS.backupVerify:
      case JOBS.backupPrune: {
        if (!deps.backup) {
          deps.log.warn({ job: job.name }, "BACKUP_ENABLED bukan true: pekerjaan backup dilewati");
          return { skipped: 1 };
        }
        const ctx = { pool: deps.pool, databaseUrl: deps.backup.databaseUrl, env: deps.backup.env };
        const run = job.name === JOBS.backup ? runBackupJob : job.name === JOBS.backupVerify ? verifyBackupJob : pruneBackupsJob;
        const detail = await run(ctx);
        deps.log.info({ job: job.name, ...detail }, "pekerjaan backup selesai");
        return { ok: 1 };
      }
      default:
        throw new Error(`Job tidak dikenal: ${job.name}`);
    }
  };
}
