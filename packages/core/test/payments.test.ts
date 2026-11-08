import { randomUUID } from "node:crypto";
import { createPool, withTenant, schema } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, FakeProvider, NotificationError, createPayment, createWorkspace, processWebhook, reconcilePayments, refundPayment, type PaymentDeps } from "../src";

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("pembayaran (Postgres asli)", () => {
  let pool: pg.Pool;
  const sfx = randomUUID().slice(0, 8);
  const provider = new FakeProvider("rahasia-uji-pembayaran");
  let now = new Date("2035-06-01T03:00:00Z");
  const deps = (): PaymentDeps => ({ pool, provider, now: () => now });
  let n = 0;

  async function mkUser(tag: string) {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [id, tag, `${tag}-${sfx}-${++n}@pay.local`]);
    return id;
  }
  /** Workspace + pemilik + (opsional) akun pembayaran terverifikasi + booking 'pending' berDP. */
  async function setup(opts: { verified?: boolean } = {}) {
    const owner = await mkUser("own");
    const slug = `pay-${sfx}-${++n}`;
    const ws = await createWorkspace(pool, owner, { name: "Pay", slug });
    const member = (await pool.query(`SELECT id FROM workspace_members WHERE workspace_id = $1`, [ws.id])).rows[0].id as string;
    if (opts.verified !== false) await pool.query(`INSERT INTO payment_accounts (workspace_id, provider, provider_account_id, kyc_status) VALUES ($1, 'fake', 'M-TEST', 'verified')`, [ws.id]);
    const mt = (await pool.query(`INSERT INTO meeting_types (workspace_id, slug, title, duration_min, location_kind, deposit_idr) VALUES ($1, 'k', 'Konsultasi', 60, 'link', 50000) RETURNING id`, [ws.id])).rows[0].id as string;
    const client = (await pool.query(`INSERT INTO workspace_clients (workspace_id, name, email) VALUES ($1, 'Tamu', $2) RETURNING id`, [ws.id, `tamu-${++n}-${sfx}@pay.local`])).rows[0].id as string;
    const newBooking = async (hoursAhead: number) => {
      const start = new Date(now.getTime() + hoursAhead * 3600_000);
      const end = new Date(start.getTime() + 3600_000);
      return (await pool.query(`INSERT INTO bookings (workspace_id, meeting_type_id, member_id, client_id, during, status, cancel_token_hash, starts_at, ends_at) VALUES ($1,$2,$3,$4,tstzrange($5,$6),'pending',$7,$5,$6) RETURNING id`, [ws.id, mt, member, client, start, end, randomUUID()])).rows[0].id as string;
    };
    return { owner, ws, slug, member, client, newBooking };
  }
  const pay = (s: Awaited<ReturnType<typeof setup>>, bookingId: string, key = `booking:${bookingId}`) =>
    createPayment(deps(), { workspaceId: s.ws.id, subjectType: "booking", subjectId: bookingId, amountIdr: 50000, idempotencyKey: key, customer: { name: "Tamu" }, description: "DP" });
  const status = async (id: string) => (await pool.query(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status as string;
  const bookingStatus = async (id: string) => (await pool.query(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0].status as string;
  const trail = async (id: string) => (await pool.query(`SELECT from_status, to_status, source FROM payment_events WHERE payment_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => `${r.from_status ?? "-"}>${r.to_status}:${r.source}`);
  const hook = (orderId: string, kind: Parameters<FakeProvider["signedNotification"]>[0]["kind"], amountIdr = 50000, eventId?: string) => provider.signedNotification({ orderId, kind, amountIdr, eventId });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : (e as Error).message));

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
  });
  afterAll(async () => pool.end());

  it("ATURAN #3: tanpa akun penyedia terverifikasi pembayaran ditolak dan tak ada baris dibuat", async () => {
    const s = await setup({ verified: false });
    const b = await s.newBooking(48);
    expect(await code(pay(s, b))).toBe("payment_unavailable");
    await pool.query(`INSERT INTO payment_accounts (workspace_id, provider, provider_account_id, kyc_status) VALUES ($1, 'fake', 'M-X', 'pending')`, [s.ws.id]);
    expect(await code(pay(s, b))).toBe("payment_unavailable"); // pending belum cukup
    expect((await pool.query(`SELECT 1 FROM payments WHERE workspace_id = $1`, [s.ws.id])).rowCount).toBe(0);
  });

  it("membuat pembayaran: pending + tautan bayar, idempoten per kunci, nominal ke penyedia integer", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const first = await pay(s, b);
    expect(first.status).toBe("pending");
    expect(first.checkoutUrl).toContain(first.paymentId);
    const again = await pay(s, b);
    expect(again.paymentId).toBe(first.paymentId);
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE workspace_id = $1`, [s.ws.id])).rows[0].n).toBe(1);
    expect(provider.charges.get(first.paymentId)?.amountIdr).toBe(50000);
    expect(await trail(first.paymentId)).toEqual(["->created:api", "created>pending:api"]);
  });

  it("penyedia gagal membuat transaksi: pembayaran 'failed', booking DILEPAS (slot kembali), jejak lengkap", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    provider.failCreate = true;
    try {
      expect(await code(pay(s, b))).toBe("payment_failed");
    } finally {
      provider.failCreate = false;
    }
    const row = (await pool.query(`SELECT id, status FROM payments WHERE workspace_id = $1`, [s.ws.id])).rows[0];
    expect(row.status).toBe("failed");
    expect(await bookingStatus(b)).toBe("cancelled");
    expect(await trail(row.id)).toEqual(["->created:api", "created>failed:api"]);
  });

  it("WEBHOOK paid: booking dikonfirmasi, jejak created→pending→paid; kiriman GANDA tidak menggandakan apa pun", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    const w = hook(paymentId, "paid");
    expect(await processWebhook(deps(), w.body, w.headers)).toBe("processed");
    expect(await status(paymentId)).toBe("paid");
    expect(await bookingStatus(b)).toBe("confirmed");
    expect(await processWebhook(deps(), w.body, w.headers)).toBe("duplicate");
    expect(await processWebhook(deps(), w.body, w.headers)).toBe("duplicate");
    expect(await trail(paymentId)).toEqual(["->created:api", "created>pending:api", "pending>paid:webhook"]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM webhook_inbox WHERE event_id = $1`, [`${paymentId}:paid`])).rows[0].n).toBe(1);
  });

  it("WEBHOOK balapan: dua pengiriman paralel dengan id event sama → tepat satu diproses", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    const w = hook(paymentId, "paid");
    const res = await Promise.all(Array.from({ length: 6 }, () => processWebhook(deps(), w.body, w.headers)));
    expect(res.filter((r) => r === "processed")).toHaveLength(1);
    expect(res.filter((r) => r === "duplicate")).toHaveLength(5);
    expect((await trail(paymentId)).filter((t) => t.includes(">paid"))).toHaveLength(1);
  });

  it("WEBHOOK terlambat/terbalik urutan: 'pending' dan 'expire' setelah 'paid' diabaikan, status tidak mundur", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    const paid = hook(paymentId, "paid");
    await processWebhook(deps(), paid.body, paid.headers);
    const latePending = hook(paymentId, "pending", 50000, `${paymentId}:pending-late`);
    const lateExpire = hook(paymentId, "expired", 50000, `${paymentId}:expire-late`);
    expect(await processWebhook(deps(), latePending.body, latePending.headers)).toBe("ignored");
    expect(await processWebhook(deps(), lateExpire.body, lateExpire.headers)).toBe("ignored");
    expect(await status(paymentId)).toBe("paid");
    expect(await bookingStatus(b)).toBe("confirmed");
    expect((await pool.query(`SELECT status FROM webhook_inbox WHERE event_id = $1`, [`${paymentId}:expire-late`])).rows[0].status).toBe("ignored");
  });

  it("WEBHOOK ditolak: tanda tangan salah (tak disimpan), nominal tak cocok (dicatat, status tetap), pesanan tak dikenal (diabaikan)", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    const good = hook(paymentId, "paid");
    await expect(processWebhook(deps(), good.body.replace("50000", "1"), good.headers)).rejects.toBeInstanceOf(NotificationError);
    expect((await pool.query(`SELECT 1 FROM webhook_inbox WHERE event_id = $1`, [`${paymentId}:paid`])).rowCount).toBe(0);
    const cheat = hook(paymentId, "paid", 1000, `${paymentId}:cheat`);
    expect(await processWebhook(deps(), cheat.body, cheat.headers)).toBe("rejected");
    expect(await status(paymentId)).toBe("pending");
    expect(await bookingStatus(b)).toBe("pending");
    const ghost = hook(randomUUID(), "paid");
    expect(await processWebhook(deps(), ghost.body, ghost.headers)).toBe("ignored");
  });

  it("kedaluwarsa lewat rekonsiliasi melepas booking; bayar TERLAMBAT tetap diakui lalu OTOMATIS direfund (dana tak tertahan)", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    now = new Date(now.getTime() + 31 * 60_000);
    const r = await reconcilePayments(deps());
    expect(r.changed).toBeGreaterThanOrEqual(1);
    expect(await status(paymentId)).toBe("expired");
    expect(await bookingStatus(b)).toBe("cancelled");
    const late = hook(paymentId, "paid", 50000, `${paymentId}:late-paid`);
    expect(await processWebhook(deps(), late.body, late.headers)).toBe("processed");
    expect(await bookingStatus(b)).toBe("cancelled"); // slot sudah dilepas: tidak dihidupkan lagi
    expect(await status(paymentId)).toBe("refunded");
    expect(provider.refunds.filter((x) => x.orderId === paymentId)).toHaveLength(1);
    expect(await trail(paymentId)).toEqual(["->created:api", "created>pending:api", "pending>expired:reconcile", "expired>paid:webhook", "paid>refund_pending:system", "refund_pending>refunded:system"]);
  });

  it("rekonsiliasi: penyedia melaporkan LUNAS padahal webhook hilang → diakui, booking dikonfirmasi", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    provider.charges.get(paymentId)!.status = "paid";
    now = new Date(now.getTime() + 31 * 60_000);
    await reconcilePayments(deps());
    expect(await status(paymentId)).toBe("paid");
    expect(await bookingStatus(b)).toBe("confirmed");
    expect(await trail(paymentId)).toContain("pending>paid:reconcile");
  });

  it("REFUND: sebagian lalu sisanya; berlebih ditolak; dobel-klik paralel hanya satu yang jalan; penyedia gagal → kembali ke 'paid'", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    const w = hook(paymentId, "paid");
    await processWebhook(deps(), w.body, w.headers);
    const actor = { userId: s.owner, slug: s.slug };

    provider.failRefund = true;
    try {
      await refundPayment(deps(), actor, paymentId, 10000);
    } finally {
      provider.failRefund = false;
    }
    expect(await status(paymentId)).toBe("paid");
    expect((await pool.query(`SELECT status FROM refunds WHERE payment_id = $1`, [paymentId])).rows.map((r) => r.status)).toEqual(["failed"]);

    expect(await code(refundPayment(deps(), actor, paymentId, 60000))).toBe("invalid_input");
    await refundPayment(deps(), actor, paymentId, 20000);
    expect(await status(paymentId)).toBe("partially_refunded");
    expect((await pool.query(`SELECT refunded_idr FROM payments WHERE id = $1`, [paymentId])).rows[0].refunded_idr).toBe("20000");

    const racers = await Promise.allSettled([refundPayment(deps(), actor, paymentId), refundPayment(deps(), actor, paymentId)]);
    expect(racers.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await status(paymentId)).toBe("refunded");
    const sent = provider.refunds.filter((r) => r.orderId === paymentId);
    expect(sent.map((r) => r.amountIdr).sort((a, c) => a - c)).toEqual([20000, 30000]);
    expect(new Set(sent.map((r) => r.key)).size).toBe(sent.length); // kunci idempoten unik
    expect(await code(refundPayment(deps(), actor, paymentId))).toBe("invalid_input"); // sudah lunas direfund
  });

  it("refund: staf biasa dan orang luar ditolak", async () => {
    const s = await setup();
    const b = await s.newBooking(48);
    const { paymentId } = await pay(s, b);
    const w = hook(paymentId, "paid");
    await processWebhook(deps(), w.body, w.headers);
    const outsider = await mkUser("luar");
    expect(await code(refundPayment(deps(), { userId: outsider, slug: s.slug }, paymentId))).toBe("not_found");
    const staff = await mkUser("staf");
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'staff')`, [s.ws.id, staff]);
    expect(await code(refundPayment(deps(), { userId: staff, slug: s.slug }, paymentId))).toBe("forbidden");
    expect(await status(paymentId)).toBe("paid");
  });

  it("DB: role aplikasi tidak bisa menulis pembayaran; riwayat append-only; lintas-workspace tak terbaca; staf tak bisa mengesahkan KYC", async () => {
    const a = await setup();
    const other = await setup();
    const b = await a.newBooking(48);
    const { paymentId } = await pay(a, b);

    await expect(withTenant(pool, { userId: a.owner, workspaceId: a.ws.id }, (db) => db.update(schema.payments).set({ status: "paid" }).where(eq(schema.payments.id, paymentId)))).rejects.toThrow();
    await expect(withTenant(pool, { userId: a.owner, workspaceId: a.ws.id }, (db) => db.insert(schema.payments).values({ workspaceId: a.ws.id, provider: "fake", providerRef: "x", amountIdr: 5000, subjectType: "booking", subjectId: b, idempotencyKey: "x", expiresAt: new Date() }))).rejects.toThrow();
    const grants = (await pool.query(`SELECT has_table_privilege('jadwalin_app','payment_events','UPDATE') AS a, has_table_privilege('jadwalin_worker','payment_events','UPDATE') AS w, has_table_privilege('jadwalin_worker','payment_events','DELETE') AS d, has_table_privilege('jadwalin_app','webhook_inbox','SELECT') AS inbox`)).rows[0];
    expect(grants).toEqual({ a: false, w: false, d: false, inbox: false });

    const seen = await withTenant(pool, { userId: other.owner, workspaceId: other.ws.id }, (db) => db.select().from(schema.payments));
    expect(seen.map((p) => p.id)).not.toContain(paymentId);
    const mine = await withTenant(pool, { userId: a.owner, workspaceId: a.ws.id }, (db) => db.select().from(schema.payments));
    expect(mine.map((p) => p.id)).toContain(paymentId);

    await expect(withTenant(pool, { userId: a.owner, workspaceId: a.ws.id }, (db) => db.insert(schema.paymentAccounts).values({ workspaceId: a.ws.id, provider: "lain", providerAccountId: "M1", kycStatus: "verified" }))).rejects.toThrow();
    await withTenant(pool, { userId: a.owner, workspaceId: a.ws.id }, (db) => db.insert(schema.paymentAccounts).values({ workspaceId: a.ws.id, provider: "lain", providerAccountId: "M1" })); // 'pending' boleh
  });
});
