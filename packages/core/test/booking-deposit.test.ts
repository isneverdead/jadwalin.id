import { randomUUID } from "node:crypto";
import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError, FakeProvider, bookPublic, bookingPaymentHooks, createMeetingType, createWorkspace, getLimits, processWebhook, reconcilePayments, setWeeklyAvailability, type PaymentDeps } from "../src";

const url = process.env.DATABASE_URL;
const NOW = new Date("2036-03-03T00:00:00Z"); // Senin
describe.skipIf(!url)("booking dengan DP (Postgres asli)", () => {
  let pool: pg.Pool;
  const sfx = randomUUID().slice(0, 8);
  const provider = new FakeProvider("rahasia-uji-dp");
  let clock = NOW;
  const payments = (): PaymentDeps => ({ pool, provider, now: () => clock, hooks: bookingPaymentHooks({ baseUrl: "http://t.local" }) });
  let owner: string;
  let slug: string;
  let wsId: string;
  let n = 0;
  const slot = (i: number) => new Date(Date.UTC(2036, 2, 10 + 7 * Math.floor(i / 3), 2 + (i % 3))); // Senin 09–11 WIB
  let si = 0;
  const guest = (extra: Record<string, unknown> = {}) => ({ name: "Tamu DP", email: `dp${++n}-${sfx}@dp.local`, topic: "Konsultasi berbayar", startsAt: slot(si++), privacyAck: true, ...extra }) as Parameters<typeof bookPublic>[3];
  const opts = (withPay = true) => ({ baseUrl: "http://t.local", now: NOW, ...(withPay ? { payments: payments() } : {}) });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));
  const bstat = async (id: string) => (await pool.query(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0].status as string;
  const mails = async (to: string) => (await pool.query(`SELECT payload->>'subject' AS subject, status FROM notification_outbox WHERE recipient = $1 ORDER BY created_at`, [to])).rows as { subject: string; status: string }[];
  const verify = () => pool.query(`INSERT INTO payment_accounts (workspace_id, provider, provider_account_id, kyc_status) VALUES ($1, 'fake', 'M-DP', 'verified') ON CONFLICT (workspace_id, provider) DO UPDATE SET kyc_status = 'verified'`, [wsId]);

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    owner = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'Pemilik', true) RETURNING id`, [`own-${sfx}@dp.local`])).rows[0].id;
    slug = `dp-${sfx}`;
    wsId = (await createWorkspace(pool, owner, { name: "Praktik DP", slug })).id;
    await setWeeklyAvailability(pool, { userId: owner, slug }, { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    await createMeetingType(pool, { userId: owner, slug }, { slug: "berbayar", title: "Konsultasi berbayar", durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 365, locationKind: "link", locationValue: "https://meet.example.com/dp", depositIdr: 75000 });
    await createMeetingType(pool, { userId: owner, slug }, { slug: "gratis", title: "Sesi gratis", durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 365, locationKind: "link", locationValue: "https://meet.example.com/gratis" });
  });
  afterAll(async () => pool?.end());

  it("validasi DP: integer, 0 atau ≥ Rp1.000; entitlements memuat fee platform integer", async () => {
    const mk = (d: number) => createMeetingType(pool, { userId: owner, slug }, { slug: `v-${++n}`, title: "Validasi", durationMin: 30, locationKind: "phone", depositIdr: d });
    expect(await code(mk(500))).toBe("invalid_input");
    expect(await code(mk(1.5))).toBe("invalid_input");
    expect(await code(mk(-1))).toBe("invalid_input");
    expect(await code(mk(1000))).toBe("ok");
    expect(Number.isInteger((await getLimits(wsId)).platformFeeBps)).toBe(true);
  });

  it("GAGAL TERTUTUP: jenis berDP tanpa layanan pembayaran / tanpa akun terverifikasi tidak menahan slot sama sekali", async () => {
    const s1 = slot(si);
    expect(await code(bookPublic(pool, slug, "berbayar", guest({ startsAt: s1 }), opts(false)))).toBe("payment_unavailable");
    expect(await code(bookPublic(pool, slug, "berbayar", guest({ startsAt: s1 }), opts()))).toBe("payment_unavailable"); // belum ada akun
    expect((await pool.query(`SELECT 1 FROM bookings WHERE workspace_id = $1 AND starts_at = $2`, [wsId, s1])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM payments WHERE workspace_id = $1`, [wsId])).rowCount).toBe(0);
  });

  it("alur lunas: slot ditahan 'pending' → tautan bayar → webhook paid → 'confirmed'; email: menunggu bayar lalu pembayaran diterima; host baru diberi tahu setelah lunas", async () => {
    await verify();
    const g = guest();
    const r = await bookPublic(pool, slug, "berbayar", g, opts());
    expect(r.payment?.checkoutUrl).toContain("pay.fake.local");
    expect(await bstat(r.bookingId)).toBe("pending");
    const before = await mails(g.email);
    expect(before.map((m) => m.subject)).toEqual([`Menunggu pembayaran: Konsultasi berbayar`, expect.stringContaining("Pengingat"), expect.stringContaining("Pengingat")].slice(0, before.length));
    expect(before[0]!.subject).toBe("Menunggu pembayaran: Konsultasi berbayar");
    expect((await pool.query(`SELECT 1 FROM notification_outbox WHERE workspace_id = $1 AND payload->>'subject' LIKE 'Booking berbayar%'`, [wsId])).rowCount).toBe(0);

    // Slot tertahan: pemesan lain pada slot sama ditolak selama pending.
    expect(await code(bookPublic(pool, slug, "berbayar", guest({ startsAt: g.startsAt }), opts()))).toBe("slot_unavailable");

    const w = provider.signedNotification({ orderId: r.payment!.paymentId, kind: "paid", amountIdr: 75000 });
    expect(await processWebhook(payments(), w.body, w.headers)).toBe("processed");
    expect(await bstat(r.bookingId)).toBe("confirmed");
    expect((await mails(g.email)).map((m) => m.subject)).toContain("Pembayaran diterima: Konsultasi berbayar");
    expect((await pool.query(`SELECT 1 FROM notification_outbox WHERE workspace_id = $1 AND payload->>'subject' LIKE 'Booking berbayar%'`, [wsId])).rowCount).toBeGreaterThanOrEqual(1);
    expect(await processWebhook(payments(), w.body, w.headers)).toBe("duplicate");
    expect((await mails(g.email)).filter((m) => m.subject.startsWith("Pembayaran diterima"))).toHaveLength(1);
  });

  it("tidak dibayar: kedaluwarsa melepas slot, pengingat dibatalkan, slot bisa dipesan lagi", async () => {
    const g = guest();
    const r = await bookPublic(pool, slug, "berbayar", g, opts());
    clock = new Date(NOW.getTime() + 31 * 60_000);
    await reconcilePayments(payments());
    expect(await bstat(r.bookingId)).toBe("cancelled");
    expect((await mails(g.email)).filter((m) => m.subject.startsWith("Pengingat")).every((m) => m.status === "cancelled")).toBe(true);
    clock = NOW;
    const again = await bookPublic(pool, slug, "berbayar", guest({ startsAt: g.startsAt }), opts());
    expect(await bstat(again.bookingId)).toBe("pending");
  });

  it("penyedia gagal saat membuat transaksi: booking dilepas, tamu mendapat galat ramah, slot kembali", async () => {
    const g = guest();
    provider.failCreate = true;
    try {
      expect(await code(bookPublic(pool, slug, "berbayar", g, opts()))).toBe("payment_failed");
    } finally {
      provider.failCreate = false;
    }
    expect((await pool.query(`SELECT status FROM bookings WHERE workspace_id = $1 AND starts_at = $2`, [wsId, g.startsAt])).rows.map((r) => r.status)).toEqual(["cancelled"]);
    const ok = await bookPublic(pool, slug, "berbayar", guest({ startsAt: g.startsAt }), opts());
    expect(ok.payment).not.toBeNull();
  });

  it("jenis gratis tetap langsung terkonfirmasi tanpa pembayaran", async () => {
    const r = await bookPublic(pool, slug, "gratis", guest(), opts(false));
    expect(r.payment).toBeNull();
    expect(await bstat(r.bookingId)).toBe("confirmed");
  });
});
