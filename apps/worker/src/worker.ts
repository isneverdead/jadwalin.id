import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { reportError } from "@jadwalin/core";
import { createProcessor, JOBS, type WorkerDeps } from "./processors";

export interface StartOptions {
  redisUrl: string;
  deps: WorkerDeps;
  /** Nama antrian; tes memakai nama unik agar tidak bertabrakan dengan worker dev. */
  queueName?: string;
  dispatchEveryMs?: number;
  cleanupEveryMs?: number;
  reconcileEveryMs?: number;
}

export interface RunningWorker {
  queue: Queue;
  close(): Promise<void>;
}

export async function startWorker(opts: StartOptions): Promise<RunningWorker> {
  const queueName = opts.queueName ?? "jadwalin";
  // BullMQ mensyaratkan maxRetriesPerRequest null untuk koneksi worker.
  const connection = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection });

  // Job scheduler: Redis menjamin satu penjadwalan per id walau banyak instance worker menyala.
  await queue.upsertJobScheduler(JOBS.dispatchEmail, { every: opts.dispatchEveryMs ?? 5_000 }, { name: JOBS.dispatchEmail, opts: { removeOnComplete: 20, removeOnFail: 100 } });
  await queue.upsertJobScheduler(JOBS.cleanupFiles, { every: opts.cleanupEveryMs ?? 3_600_000 }, { name: JOBS.cleanupFiles, opts: { removeOnComplete: 5, removeOnFail: 50 } });

  await queue.upsertJobScheduler(JOBS.cleanupRateCounters, { every: opts.cleanupEveryMs ?? 3_600_000 }, { name: JOBS.cleanupRateCounters, opts: { removeOnComplete: 5, removeOnFail: 50 } });

  // Detak worker tiap menit (dibaca endpoint kesiapan) dan jadwal backup (zona Asia/Jakarta; hanya bila diaktifkan).
  await queue.upsertJobScheduler(JOBS.heartbeat, { every: 60_000 }, { name: JOBS.heartbeat, opts: { removeOnComplete: 5, removeOnFail: 20 } });
  // Rekonsiliasi pembayaran macet/kedaluwarsa tiap 2 menit (slot DP yang tak dibayar dilepas; lunas yang webhook-nya hilang diakui).
  if (opts.deps.payments) await queue.upsertJobScheduler(JOBS.reconcilePayments, { every: opts.reconcileEveryMs ?? 120_000 }, { name: JOBS.reconcilePayments, opts: { removeOnComplete: 10, removeOnFail: 50 } });
  if (opts.deps.backup) {
    const tz = "Asia/Jakarta";
    await queue.upsertJobScheduler(JOBS.backup, { pattern: "0 2 * * *", tz }, { name: JOBS.backup, opts: { removeOnComplete: 10, removeOnFail: 50, attempts: 2, backoff: { type: "fixed", delay: 600_000 } } });
    await queue.upsertJobScheduler(JOBS.backupVerify, { pattern: "30 3 * * *", tz }, { name: JOBS.backupVerify, opts: { removeOnComplete: 10, removeOnFail: 50 } });
    await queue.upsertJobScheduler(JOBS.backupPrune, { pattern: "0 4 * * 0", tz }, { name: JOBS.backupPrune, opts: { removeOnComplete: 10, removeOnFail: 50 } });
  }

  const process = createProcessor(opts.deps);
  const worker = new Worker(queueName, process, { connection, concurrency: 2 });
  worker.on("failed", (job, err) => {
    opts.deps.log.error({ job: job?.name, err: err.message }, "job gagal");
    reportError(err, { where: `job:${job?.name ?? "?"}` });
  });
  worker.on("error", (err) => opts.deps.log.error({ err: err.message }, "worker error"));
  await worker.waitUntilReady();

  return {
    queue,
    async close() {
      await worker.close();
      await queue.close();
      await connection.quit().catch(() => undefined);
    },
  };
}
