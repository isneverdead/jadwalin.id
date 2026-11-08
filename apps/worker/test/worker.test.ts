import { enqueueSystemEmail, MemoryEmailSender } from "@jadwalin/core";
import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProcessor, JOBS } from "../src/processors";
import { startWorker } from "../src/worker";

const url = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const sfx = Math.random().toString(36).slice(2, 8);
const quiet = { info() {}, warn() {}, error() {} };

async function waitFor<T>(fn: () => Promise<T | false | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: waktu habis");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!url || !redisUrl)("worker (BullMQ + Redis + Postgres asli)", () => {
  let pool: pg.Pool;
  const queueName = `uji-${sfx}`;

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
  });
  afterAll(async () => {
    await pool?.end();
  });

  const sys = (to: string) =>
    enqueueSystemEmail(pool, { to, template: "reset_password", payload: { name: "Uji", url: "https://app.test/r" }, dedupeKey: `w-${sfx}-${to}` });
  const status = async (to: string) => (await pool.query(`SELECT status FROM notification_outbox WHERE recipient = $1`, [to])).rows[0]?.status;

  it("pemroses langsung: dispatch mengirim pesan jatuh tempo; job tak dikenal gagal", async () => {
    const to = `langsung-${sfx}@worker.local`;
    await sys(to);
    const sender = new MemoryEmailSender();
    const run = createProcessor({ pool, sender, from: "x <x@x.test>", log: quiet });
    const stats = await run({ name: JOBS.dispatchEmail });
    expect(stats.sent).toBeGreaterThanOrEqual(1);
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
    await expect(run({ name: "ngawur" })).rejects.toThrow(/tidak dikenal/);
    expect(await run({ name: JOBS.cleanupFiles })).toEqual({ removed: 0 }); // tanpa storage: dilewati
  });

  it("BullMQ menjalankan dispatch terjadwal: email antre terkirim tanpa dipanggil manual", async () => {
    const to = `terjadwal-${sfx}@worker.local`;
    const sender = new MemoryEmailSender();
    const w = await startWorker({ redisUrl: redisUrl!, queueName, dispatchEveryMs: 200, deps: { pool, sender, from: "x <x@x.test>", log: quiet } });
    try {
      await sys(to);
      await waitFor(async () => (await status(to)) === "sent");
      expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
    } finally {
      await w.close(); // worker yang masih hidup akan ikut mengambil pesan tes lain
    }
  });

  it("KONKURENSI: dua instance worker pada antrian yang sama tidak mengirim ganda", async () => {
    const sender = new MemoryEmailSender();
    sender.delayMs = 30;
    const deps = { pool, sender, from: "x <x@x.test>", log: quiet };
    const name = `ganda-${sfx}`;
    const workers = [
      await startWorker({ redisUrl: redisUrl!, queueName: name, dispatchEveryMs: 150, deps }),
      await startWorker({ redisUrl: redisUrl!, queueName: name, dispatchEveryMs: 150, deps }),
    ];
    try {
      const tos = Array.from({ length: 15 }, (_, i) => `ganda${i}-${sfx}@worker.local`);
      await Promise.all(tos.map(sys));
      await waitFor(async () => (await Promise.all(tos.map(status))).every((s) => s === "sent"));
      for (const to of tos) expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
  });

  it("detak worker dicatat di job_status; pekerjaan backup dilewati bila dimatikan (tidak gagal diam-diam)", async () => {
    const warns: string[] = [];
    const run = createProcessor({ pool, sender: new MemoryEmailSender(), from: "x <x@x.test>", log: { ...quiet, warn: (_o, m) => void warns.push(String(m)) }, backup: null });
    expect(await run({ name: JOBS.heartbeat })).toEqual({ ok: 1 });
    const hb = (await pool.query(`SELECT last_ok_at FROM job_status WHERE job = 'worker_heartbeat'`)).rows[0];
    expect(Date.now() - new Date(hb.last_ok_at).getTime()).toBeLessThan(10_000);
    expect(await run({ name: JOBS.backup })).toEqual({ skipped: 1 });
    expect(warns.join(" ")).toContain("BACKUP_ENABLED");
  });

  it("kegagalan pengiriman dicoba ulang oleh jadwal berikutnya setelah backoff, bukan hilang", async () => {
    const to = `gagal-${sfx}@worker.local`;
    const sender = new MemoryEmailSender();
    sender.failWhen = (m) => m.to === to;
    await sys(to);
    const run = createProcessor({ pool, sender, from: "x <x@x.test>", log: quiet });
    await run({ name: JOBS.dispatchEmail });
    const r = (await pool.query(`SELECT status, attempts, last_error, send_at > now() AS later FROM notification_outbox WHERE recipient = $1`, [to])).rows[0];
    expect(r).toMatchObject({ status: "queued", attempts: 1, last_error: "penyedia email tidak tersedia", later: true });
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(0);
  });
});
