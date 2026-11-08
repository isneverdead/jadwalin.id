import { createPool, withTenant, withWorker } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { sql } from "drizzle-orm";
import { createServer, type AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  backoffMs,
  createWorkspace,
  dispatchDue,
  enqueueEmail,
  enqueueSystemEmail,
  escapeHtml,
  MemoryEmailSender,
  renderEmail,
  SmtpEmailSender,
  withWorkspace,
} from "../src";

describe("template email", () => {
  it("menolak payload tak lengkap dan URL non-http", () => {
    expect(() => renderEmail("verify_email", { name: "A" })).toThrow();
    expect(() => renderEmail("verify_email", { name: "A", url: "javascript:alert(1)" })).toThrow();
    expect(() => renderEmail("tidak_ada", {})).toThrow();
  });
  it("HTML di-escape sehingga nama pengguna tidak bisa menyisipkan markup", () => {
    const r = renderEmail("workspace_invite", { url: "https://x.test/undangan/abc", workspaceName: "<script>alert(1)</script>", inviterName: 'A "B"', roleLabel: "staf" });
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.subject).toContain("<script>"); // subjek adalah teks biasa, bukan HTML
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
  it("backoff naik dan berhenti di batas atas", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000]);
  });
});

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);
const FROM = "jadwalin <noreply@jadwalin.test>";

describe.skipIf(!url)("outbox email (Postgres asli)", () => {
  let pool: pg.Pool;
  let ownerId: string;
  let otherOwnerId: string;
  let wsId: string;
  const slug = `notif-${sfx}`;
  const owner = () => ({ userId: ownerId, slug });
  let n = 0;
  const rcpt = () => `r${++n}-${sfx}@notif.local`;
  const tpl = (to: string) => ({ to, template: "reset_password" as const, payload: { name: "Uji", url: `https://app.test/reset/${n}` } });

  const enqueue = (input: { to: string; dedupeKey?: string; sendAt?: Date; template?: "reset_password" | "workspace_invite"; payload?: Record<string, unknown> }) =>
    withWorkspace(pool, owner(), "staff", (db, access) =>
      enqueueEmail(db, { workspaceId: access.workspaceId, template: "reset_password", payload: { name: "Uji", url: "https://app.test/x" }, ...input }),
    );
  const row = async (to: string) => (await pool.query(`SELECT * FROM notification_outbox WHERE recipient = $1 ORDER BY created_at`, [to])).rows;
  const used = async () => (await pool.query(`SELECT used FROM notification_quota_usage WHERE workspace_id = $1`, [wsId])).rows[0]?.used ?? 0;
  const dispatch = (sender: MemoryEmailSender, opts: { now?: Date; maxAttempts?: number } = {}) => dispatchDue(pool, { sender, from: FROM, limit: 500, ...opts });

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    ownerId = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'Owner', true) RETURNING id`, [`o-${sfx}@notif.local`])).rows[0].id;
    otherOwnerId = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'Lain', true) RETURNING id`, [`l-${sfx}@notif.local`])).rows[0].id;
    wsId = (await createWorkspace(pool, ownerId, { name: "Notif", slug })).id;
    await createWorkspace(pool, otherOwnerId, { name: "Lain", slug: `notif-lain-${sfx}` });
  });
  afterAll(async () => pool?.end());

  it("enqueue lalu kirim: email terender, tercatat terkirim, dan kuota berkurang satu", async () => {
    const to = rcpt();
    const before = await used();
    expect((await enqueue({ to })).status).toBe("queued");
    expect(await used()).toBe(before + 1);
    const sender = new MemoryEmailSender();
    await dispatch(sender);
    const sent = sender.sent.filter((m) => m.to === to);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Atur ulang kata sandi jadwalin");
    expect(sent[0]!.from).toBe(FROM);
    const [r] = await row(to);
    expect(r.status).toBe("sent");
    expect(r.sent_at).not.toBeNull();
    expect(r.provider_message_id).toMatch(/^mem-/);
    expect(r.payload).toEqual({ redacted: true }); // token dihapus dari DB setelah terkirim
  });

  it("IDEMPOTEN: enqueue ganda dengan kunci sama = satu baris, kuota sekali", async () => {
    const to = rcpt();
    const before = await used();
    const a = await enqueue({ to, dedupeKey: "k1" });
    const b = await enqueue({ to, dedupeKey: "k1" });
    expect([a.status, b.status]).toEqual(["queued", "duplicate"]);
    expect(await row(to)).toHaveLength(1);
    expect(await used()).toBe(before + 1);
    const sender = new MemoryEmailSender();
    await dispatch(sender);
    await dispatch(sender);
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
  });

  it("transaksional: bila transaksi bisnis dibatalkan, tidak ada pesan dan kuota tidak terpakai", async () => {
    const to = rcpt();
    const before = await used();
    await expect(
      withWorkspace(pool, owner(), "staff", async (db, access) => {
        await enqueueEmail(db, { workspaceId: access.workspaceId, to, template: "reset_password", payload: { name: "x", url: "https://a.test/" } });
        throw new Error("gagal setelah enqueue");
      }),
    ).rejects.toThrow("gagal setelah enqueue");
    expect(await row(to)).toHaveLength(0);
    expect(await used()).toBe(before);
  });

  it("pesan terjadwal masa depan tidak dikirim sebelum waktunya", async () => {
    const to = rcpt();
    const at = new Date(Date.now() + 3600_000);
    await enqueue({ to, sendAt: at });
    const sender = new MemoryEmailSender();
    await dispatch(sender);
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(0);
    await dispatch(sender, { now: new Date(at.getTime() + 1000) });
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
  });

  it("RETRY: gagal → dijadwal ulang dengan backoff → berhasil; tidak dikirim lebih awal", async () => {
    const to = rcpt();
    await enqueue({ to });
    const sender = new MemoryEmailSender();
    let failuresLeft = 2;
    sender.failWhen = (m) => m.to === to && failuresLeft-- > 0;
    const t0 = new Date(Date.now() + 1000);

    let s = await dispatch(sender, { now: t0 });
    expect(s.retried).toBeGreaterThanOrEqual(1);
    let [r] = await row(to);
    expect([r.status, r.attempts, r.last_error]).toEqual(["queued", 1, "penyedia email tidak tersedia"]);
    expect(new Date(r.send_at).getTime()).toBe(t0.getTime() + 60_000);

    await dispatch(sender, { now: new Date(t0.getTime() + 30_000) }); // belum waktunya
    expect((await row(to))[0].attempts).toBe(1);

    const t1 = new Date(t0.getTime() + 61_000);
    await dispatch(sender, { now: t1 });
    [r] = await row(to);
    expect([r.status, r.attempts]).toEqual(["queued", 2]);
    expect(new Date(r.send_at).getTime()).toBe(t1.getTime() + 300_000);

    await dispatch(sender, { now: new Date(t1.getTime() + 301_000) });
    [r] = await row(to);
    expect([r.status, r.attempts, r.last_error]).toEqual(["sent", 3, null]);
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
  });

  it("gagal permanen setelah batas percobaan", async () => {
    const to = rcpt();
    await enqueue({ to });
    const sender = new MemoryEmailSender();
    sender.failWhen = (m) => m.to === to;
    let now = new Date(Date.now() + 1000);
    for (let i = 0; i < 3; i++) {
      await dispatch(sender, { now, maxAttempts: 2 });
      now = new Date(now.getTime() + 3600_000);
    }
    const [r] = await row(to);
    expect([r.status, r.attempts]).toEqual(["failed", 2]);
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(0);
  });

  it("KONKURENSI: 4 dispatcher serentak tidak pernah mengirim pesan yang sama dua kali", async () => {
    const tos = Array.from({ length: 12 }, () => rcpt());
    for (const to of tos) await enqueue({ to });
    const sender = new MemoryEmailSender();
    sender.delayMs = 20;
    await Promise.all([dispatch(sender), dispatch(sender), dispatch(sender), dispatch(sender)]);
    for (const to of tos) expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
    for (const to of tos) expect((await row(to))[0].status).toBe("sent");
  });

  it("pesan macet di 'sending' diambil ulang setelah 10 menit, bukan sebelumnya", async () => {
    const to = rcpt();
    await enqueue({ to });
    await pool.query(`UPDATE notification_outbox SET status = 'sending', locked_at = $2, attempts = 1 WHERE recipient = $1`, [to, new Date()]);
    const sender = new MemoryEmailSender();
    await dispatch(sender);
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(0);
    await dispatch(sender, { now: new Date(Date.now() + 11 * 60_000) });
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(1);
  });

  it("KUOTA: bila habis, pesan dicatat skipped_quota dan tidak pernah terkirim", async () => {
    await pool.query(`UPDATE notification_quota_usage SET used = 1000 WHERE workspace_id = $1`, [wsId]);
    const to = rcpt();
    const r = await enqueue({ to });
    expect(r.status).toBe("skipped_quota");
    expect(await used()).toBe(1000); // tidak melewati batas
    const sender = new MemoryEmailSender();
    await dispatch(sender);
    expect(sender.sent.filter((m) => m.to === to)).toHaveLength(0);
    expect((await row(to))[0].status).toBe("skipped_quota");
    await pool.query(`UPDATE notification_quota_usage SET used = 0 WHERE workspace_id = $1`, [wsId]);
  });

  it("KUOTA serentak: 30 enqueue paralel pada sisa kuota 10 → tepat 10 antre", async () => {
    await pool.query(`UPDATE notification_quota_usage SET used = 990 WHERE workspace_id = $1`, [wsId]);
    const results = await Promise.all(Array.from({ length: 30 }, () => enqueue({ to: rcpt() })));
    expect(results.filter((r) => r.status === "queued")).toHaveLength(10);
    expect(results.filter((r) => r.status === "skipped_quota")).toHaveLength(20);
    expect(await used()).toBe(1000);
    await pool.query(`UPDATE notification_quota_usage SET used = 0 WHERE workspace_id = $1`, [wsId]);
  });

  it("email sistem tanpa workspace tidak memakai kuota workspace mana pun", async () => {
    const to = rcpt();
    const before = await used();
    const r = await enqueueSystemEmail(pool, { to, template: "verify_email", payload: { name: "Uji", url: "https://app.test/v" }, dedupeKey: `v-${sfx}-${to}` });
    expect(r.status).toBe("queued");
    expect(await used()).toBe(before);
    expect((await row(to))[0].workspace_id).toBeNull();
  });

  it("isolasi: workspace lain dan tenant tidak bisa melihat outbox; alamat email tak valid ditolak", async () => {
    const to = rcpt();
    await enqueue({ to });
    const seenByOther = await withTenant(pool, { userId: otherOwnerId, workspaceId: (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [`notif-lain-${sfx}`])).rows[0].id }, (db) =>
      db.execute(sql`SELECT * FROM notification_outbox WHERE recipient = ${to}`),
    );
    expect(seenByOther.rows).toHaveLength(0);
    const system = await withTenant(pool, { userId: ownerId, workspaceId: wsId }, (db) => db.execute(sql`SELECT * FROM notification_outbox WHERE workspace_id IS NULL`));
    expect(system.rows).toHaveLength(0);
    await expect(enqueue({ to: "bukan-email" })).rejects.toBeInstanceOf(AppError);
    // role tenant tidak boleh mengubah baris milik worker lewat tabel kuota/antrian di workspace lain
    const denied = await withWorker(pool, (db) => db.execute(sql`SELECT * FROM sessions`)).catch((e: { cause?: { message?: string } }) => e.cause?.message ?? "");
    expect(denied).toMatch(/permission denied/);
  });
});

describe("SmtpEmailSender (server SMTP sungguhan)", () => {
  it("mengirim email lengkap dengan header outbox ke server SMTP", async () => {
    const received: string[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, _session, cb) {
        const chunks: Buffer[] = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          received.push(Buffer.concat(chunks).toString("utf8"));
          cb();
        });
      },
    });
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const sender = new SmtpEmailSender(`smtp://127.0.0.1:${port}`);
    try {
      const r = await sender.send({ from: FROM, to: "tujuan@uji.local", subject: "Halo Ñandú", text: "isi teks", html: "<p>isi html</p>", outboxId: "outbox-123" });
      expect(r.messageId).toBeTruthy();
      expect(received).toHaveLength(1);
      expect(received[0]!.toLowerCase()).toContain("x-jadwalin-outbox-id: outbox-123");
      expect(received[0]).toContain("tujuan@uji.local");
    } finally {
      sender.close();
      await new Promise((resolve) => server.close(() => resolve(null)));
    }
  });
});
