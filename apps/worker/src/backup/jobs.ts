import type { BackupEnv } from "@jadwalin/config";
import type pg from "pg";
import { recordJob } from "../jobs-status";
import { runBackup, BACKUP_PREFIX } from "./backup";
import { listManifests, restoreAndVerify } from "./restore";
import { selectForDeletion } from "./retention";
import { BackupStore } from "./store";

export interface BackupJobContext {
  pool: pg.Pool;
  databaseUrl: string;
  env: BackupEnv;
}

function storeOf(env: BackupEnv): BackupStore {
  return new BackupStore({ endpoint: env.s3.endpoint, region: env.s3.region, bucket: env.s3.bucket, accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey, forcePathStyle: env.s3.forcePathStyle });
}

/** Jalankan satu pekerjaan dan catat hasilnya; galat dilempar ulang agar BullMQ/Sentry melihatnya. */
async function tracked<T extends Record<string, unknown>>(ctx: BackupJobContext, job: string, fn: () => Promise<T>): Promise<T> {
  try {
    const detail = await fn();
    await recordJob(ctx.pool, job, { ok: true, detail });
    return detail;
  } catch (error) {
    await recordJob(ctx.pool, job, { ok: false, error: (error as Error).message }).catch(() => undefined);
    throw error;
  }
}

export const runBackupJob = (ctx: BackupJobContext) =>
  tracked(ctx, "backup", async () => {
    const m = await runBackup({ databaseUrl: ctx.databaseUrl, passphrase: ctx.env.passphrase, store: storeOf(ctx.env), pgBinDir: ctx.env.pgBinDir });
    return { key: m.key, sizeBytes: m.sizeBytes, createdAt: m.createdAt };
  });

/** Uji restore terjadwal: pulihkan backup TERBARU ke database sementara dan verifikasi. Gagal = pekerjaan gagal (dan terpantau). */
export const verifyBackupJob = (ctx: BackupJobContext) =>
  tracked(ctx, "backup_verify", async () => {
    const report = await restoreAndVerify({ databaseUrl: ctx.env.verifyDatabaseUrl ?? ctx.databaseUrl, passphrase: ctx.env.passphrase, store: storeOf(ctx.env), pgBinDir: ctx.env.pgBinDir });
    if (!report.ok) throw new Error(`Uji restore GAGAL: ${report.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    return { key: report.manifest.key, backupCreatedAt: report.manifest.createdAt, durationMs: report.durationMs, checks: report.checks.length };
  });

export const pruneBackupsJob = (ctx: BackupJobContext) =>
  tracked(ctx, "backup_prune", async () => {
    const store = storeOf(ctx.env);
    const manifests = await listManifests(store, BACKUP_PREFIX);
    const doomed = selectForDeletion(manifests.map((m) => ({ key: m.key, createdAt: new Date(m.createdAt) })), new Date());
    for (const key of doomed) {
      await store.delete(key);
      await store.delete(`${key}.json`);
    }
    return { kept: manifests.length - doomed.length, deleted: doomed.length };
  });
