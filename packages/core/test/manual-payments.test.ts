import { randomUUID } from "node:crypto";
import { createPool, withTenant, schema } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError, ManualProvider, S3Storage, bookPublic, bookingPaymentHooks, confirmUpload, createMeetingType, createWorkspace, deletePaymentMethod, getManualPaymentView, getProofDownloadUrl, listManualPayments,
  listFiles, listPaymentMethods, reconcilePayments, refundPayment, requestProofUpload, requestUpload, reviewPayment, savePaymentMethod, setPaymentMethodActive, setWeeklyAvailability, submitProof, type PaymentDeps,
} from "../src";
import { inviteAndAccept } from "./helpers";

const url = process.env.DATABASE_URL;
const s3 = { endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY };
const haveS3 = Boolean(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey);
const NOW = new Date("2037-03-02T00:00:00Z"); // Senin
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe.skipIf(!url || !haveS3)("pembayaran manual (Postgres + S3 asli)", () => {
  let pool: pg.Pool;
  let storage: S3Storage;
  const sfx = randomUUID().slice(0, 8);
  const u = {} as Record<"owner" | "staff" | "outsider", string>;
  let slug: string;
  let wsId: string;
  let clock = NOW;
  const deps = (): PaymentDeps => ({ pool, provider: new ManualProvider(), now: () => clock, hooks: bookingPaymentHooks({ baseUrl: "http://t.local" }) });
  const owner = () => ({ userId: u.owner, slug });
  let n = 0;
  let si = 0;
  const slot = () => new Date(Date.UTC(2037, 2, 9 + 7 * Math.floor(si / 3), 2 + (si++ % 3)));
  const guest = () => ({ name: "Tamu Bayar", phone: `0812${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, email: `bayar${++n}-${sfx}@mp.local`, topic: "Konsultasi DP", startsAt: slot(), privacyAck: true }) as Parameters<typeof bookPublic>[3];
  const opts = () => ({ baseUrl: "http://t.local", now: NOW, payments: deps() });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${(e as Error).message}`));
  const bstat = async (id: string) => (await pool.query(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0].status as string;
  const pstat = async (id: string) => (await pool.query(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status as string;
  const trail = async (id: string) => (await pool.query(`SELECT from_status, to_status, source FROM payment_events WHERE payment_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => `${r.from_status ?? "-"}>${r.to_status}:${r.source}`);
  const mails = async (to: string) => (await pool.query(`SELECT payload->>'subject' AS subject FROM notification_outbox WHERE recipient = $1 ORDER BY created_at`, [to])).rows.map((r) => r.subject as string);

  async function uploadProof(token: string, bytes = PNG, mime = "image/png") {
    const { fileId, upload } = await requestProofUpload(pool, storage, token, { filename: "bukti.png", mime, sizeBytes: bytes.byteLength });
    const res = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes as unknown as BodyInit });
    expect(res.ok).toBe(true);
    return fileId;
  }
  async function bookDeposit() {
    const g = guest();
    const r = await bookPublic(pool, slug, "berbayar", g, opts());
    return { g, ...r, token: r.manageToken, paymentId: r.payment!.paymentId };
  }

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    storage = new S3Storage({ endpoint: s3.endpoint!, region: "auto", bucket: s3.bucket!, accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey!, forcePathStyle: true });
    await storage.ensureBucket();
    for (const k of ["owner", "staff", "outsider"] as const) u[k] = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [`${k}-${sfx}@mp.local`, k])).rows[0].id;
    slug = `mp-${sfx}`;
    wsId = (await createWorkspace(pool, u.owner, { name: "Praktik Manual", slug })).id;
    await createWorkspace(pool, u.outsider, { name: "Lain", slug: `mp-lain-${sfx}` });
    await inviteAndAccept(pool, owner(), { userId: u.staff, email: `staff-${sfx}@mp.local`, role: "staff" });
    await setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    await createMeetingType(pool, owner(), { slug: "berbayar", title: "Konsultasi berbayar", durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 365, locationKind: "link", locationValue: "https://meet.example.com/mp", depositIdr: 100000 });
  });
  afterAll(async () => pool?.end());

  it("metode bayar: validasi, batas, hanya admin ke atas yang mengelola, staf boleh melihat", async () => {
    expect(await code(savePaymentMethod(pool, owner(), { kind: "bank_transfer", label: "BCA", accountName: "Dewi", accountNumber: "ab" }))).toBe("invalid_input");
    expect(await code(savePaymentMethod(pool, owner(), { kind: "bank_transfer", label: "BCA", accountNumber: "1234567890" }))).toBe("invalid_input"); // tanpa nama
    expect(await code(savePaymentMethod(pool, owner(), { kind: "qris", label: "QRIS" }))).toBe("invalid_input"); // tanpa gambar
    expect(await code(savePaymentMethod(pool, owner(), { kind: "other", label: "Tunai" }))).toBe("invalid_input"); // tanpa petunjuk
    expect(await code(savePaymentMethod(pool, { userId: u.staff, slug }, { kind: "other", label: "Tunai", instructions: "Bayar di tempat" }))).toBe("forbidden");
    expect(await code(savePaymentMethod(pool, { userId: u.outsider, slug }, { kind: "other", label: "Tunai", instructions: "x" }))).toBe("not_found");
    const { id } = await savePaymentMethod(pool, owner(), { kind: "bank_transfer", label: "BCA", accountName: "Dewi Konsultan", accountNumber: "123 456 7890", instructions: "Cantumkan nama pada berita" });
    expect((await listPaymentMethods(pool, { userId: u.staff, slug })).map((m) => m.id)).toContain(id);
    await setPaymentMethodActive(pool, owner(), id, false);
    await setPaymentMethodActive(pool, owner(), id, true);
  });

  it("GAGAL TERTUTUP: jenis berDP tidak bisa dipesan bila belum ada metode bayar aktif (slot tidak tertahan)", async () => {
    await pool.query(`UPDATE payment_methods SET active = false WHERE workspace_id = $1`, [wsId]);
    const g = guest();
    expect(await code(bookPublic(pool, slug, "berbayar", g, opts()))).toBe("payment_unavailable");
    expect((await pool.query(`SELECT 1 FROM bookings WHERE workspace_id = $1 AND starts_at = $2`, [wsId, g.startsAt])).rowCount).toBe(0);
    await pool.query(`UPDATE payment_methods SET active = true WHERE workspace_id = $1`, [wsId]);
  });

  it("QRIS: gambar diunggah lewat modul berkas; tamu melihat metode + QRIS berumur pendek, hanya bila punya booking", async () => {
    const { fileId, upload } = await requestUpload(pool, owner(), storage, { filename: "qris.png", mime: "image/png", sizeBytes: PNG.byteLength });
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: PNG as unknown as BodyInit })).ok).toBe(true);
    await confirmUpload(pool, owner(), storage, fileId);
    await savePaymentMethod(pool, owner(), { kind: "qris", label: "QRIS Toko", qrisFileId: fileId });
    const b = await bookDeposit();
    const view = await getManualPaymentView(pool, storage, b.token);
    expect(view?.payment).toMatchObject({ status: "pending", amountIdr: 100000 });
    expect(view?.canUpload).toBe(true);
    expect(view?.methods.map((m) => m.label).sort()).toEqual(["BCA", "QRIS Toko"]);
    const qris = view!.methods.find((m) => m.kind === "qris")!;
    expect(qris.qrisUrl).toMatch(/^https?:\/\//);
    expect((await fetch(qris.qrisUrl!)).ok).toBe(true);
    expect(await getManualPaymentView(pool, storage, "token-ngawur")).toBeNull();
    // Pengunjung tanpa booking tidak dapat membaca metode bayar lewat RLS (nomor rekening tidak terbuka).
    const rows = await withTenant(pool, { userId: "00000000-0000-0000-0000-000000000000", workspaceId: wsId, actor: "public" }, (db) => db.select().from(schema.paymentMethods));
    expect(rows).toHaveLength(0);
  });

  it("ALUR LUNAS: booking ditahan → unggah bukti → menunggu verifikasi → staf konfirmasi → booking terkonfirmasi, email terkirim, jejak lengkap", async () => {
    const b = await bookDeposit();
    expect(await bstat(b.bookingId)).toBe("pending");
    expect(await pstat(b.paymentId)).toBe("pending");
    expect(b.payment?.checkoutUrl).toBeNull();
    expect((await mails(b.g.email!))[0]).toBe("Menunggu pembayaran: Konsultasi berbayar");

    const fileId = await uploadProof(b.token);
    await submitProof(pool, storage, b.token, fileId, "Transfer dari BCA a.n. Tamu", { baseUrl: "http://t.local", now: NOW });
    expect(await pstat(b.paymentId)).toBe("awaiting_verification");
    expect(await bstat(b.bookingId)).toBe("pending"); // slot tetap ditahan sampai staf memutuskan
    expect((await pool.query(`SELECT 1 FROM notification_outbox WHERE workspace_id = $1 AND payload->>'subject' LIKE 'Bukti pembayaran baru%'`, [wsId])).rowCount).toBeGreaterThanOrEqual(1);
    expect(await code(submitProof(pool, storage, b.token, fileId, undefined, { baseUrl: "http://t.local" }))).toBe("invalid_input"); // tak bisa dikirim dua kali

    // Bukti bayar punya tempatnya sendiri: tidak boleh bercampur di daftar menu Berkas.
    expect((await listFiles(pool, { userId: u.staff, slug })).some((f) => f.id === fileId)).toBe(false);

    const queue = await listManualPayments(pool, { userId: u.staff, slug });
    const row = queue.find((r) => r.paymentId === b.paymentId)!;
    expect(row).toMatchObject({ status: "awaiting_verification", clientName: "Tamu Bayar", typeTitle: "Konsultasi berbayar" });
    const dl = await getProofDownloadUrl(pool, { userId: u.staff, slug }, storage, row.proof!.id);
    expect((await fetch(dl.url)).ok).toBe(true);

    const r = await reviewPayment(deps(), { userId: u.staff, slug }, b.paymentId, { accept: true });
    expect(r).toEqual({ status: "paid", lateBooking: false });
    expect(await bstat(b.bookingId)).toBe("confirmed");
    expect(await trail(b.paymentId)).toEqual(["->pending:api", "pending>awaiting_verification:api", "awaiting_verification>paid:admin"]);
    expect((await mails(b.g.email!))).toContain("Pembayaran diterima: Konsultasi berbayar");
    expect((await pool.query(`SELECT status FROM payment_proofs WHERE payment_id = $1`, [b.paymentId])).rows[0].status).toBe("accepted");
    expect(await code(reviewPayment(deps(), owner(), b.paymentId, { accept: true }))).toBe("invalid_input"); // sudah lunas
  });

  it("DITOLAK: kembali 'pending' dengan alasan, jendela bayar diperpanjang, tamu bisa unggah ulang lalu dikonfirmasi", async () => {
    const b = await bookDeposit();
    await submitProof(pool, storage, b.token, await uploadProof(b.token), undefined, { baseUrl: "http://t.local", now: NOW });
    expect(await code(reviewPayment(deps(), owner(), b.paymentId, { accept: false, reason: "ab" }))).toBe("invalid_input");
    await reviewPayment(deps(), owner(), b.paymentId, { accept: false, reason: "Nominal transfer kurang Rp25.000" }, { now: NOW });
    expect(await pstat(b.paymentId)).toBe("pending");
    const view = await getManualPaymentView(pool, storage, b.token);
    expect(view).toMatchObject({ canUpload: true, proof: { status: "rejected", rejectReason: "Nominal transfer kurang Rp25.000" } });
    expect((await mails(b.g.email!))).toContain("Bukti pembayaran belum dapat diterima");
    await submitProof(pool, storage, b.token, await uploadProof(b.token), "Sudah ditambah", { baseUrl: "http://t.local", now: NOW });
    await reviewPayment(deps(), owner(), b.paymentId, { accept: true });
    expect(await bstat(b.bookingId)).toBe("confirmed");
  });

  it("tunai/di luar sistem: staf langsung menandai lunas tanpa bukti; orang luar dan klien tak bisa meninjau", async () => {
    const b = await bookDeposit();
    expect(await code(reviewPayment(deps(), { userId: u.outsider, slug }, b.paymentId, { accept: true }))).toBe("not_found");
    expect(await code(reviewPayment(deps(), owner(), b.paymentId, { accept: false, reason: "tidak ada bukti" }))).toBe("invalid_input"); // tolak hanya bila ada bukti
    expect(await reviewPayment(deps(), owner(), b.paymentId, { accept: true })).toMatchObject({ status: "paid" });
    expect(await bstat(b.bookingId)).toBe("confirmed");
  });

  it("tidak dibayar: kedaluwarsa melepas slot; 'menunggu verifikasi' TIDAK dikedaluwarsakan", async () => {
    const unpaid = await bookDeposit();
    const waiting = await bookDeposit();
    await submitProof(pool, storage, waiting.token, await uploadProof(waiting.token), undefined, { baseUrl: "http://t.local", now: NOW });
    clock = new Date(NOW.getTime() + 4 * 3600_000);
    try {
      await reconcilePayments(deps());
    } finally {
      clock = NOW;
    }
    expect(await pstat(unpaid.paymentId)).toBe("expired");
    expect(await bstat(unpaid.bookingId)).toBe("cancelled");
    expect(await pstat(waiting.paymentId)).toBe("awaiting_verification");
    expect(await bstat(waiting.bookingId)).toBe("pending");
    expect(await code(requestProofUpload(pool, storage, unpaid.token, { filename: "x.png", mime: "image/png", sizeBytes: 10 }))).toBe("invalid_input");
  });

  it("batas unggah bukti: tipe/ukuran, token lain, berkas orang lain, dan berkas yang tak benar-benar terunggah", async () => {
    const a = await bookDeposit();
    const c = await bookDeposit();
    expect(await code(requestProofUpload(pool, storage, a.token, { filename: "x.html", mime: "text/html", sizeBytes: 10 }))).toBe("invalid_input");
    expect(await code(requestProofUpload(pool, storage, a.token, { filename: "x.png", mime: "image/png", sizeBytes: 6 * 1024 * 1024 }))).toBe("invalid_input");
    expect(await code(requestProofUpload(pool, storage, "token-ngawur", { filename: "x.png", mime: "image/png", sizeBytes: 10 }))).toBe("not_found");
    const fileA = await uploadProof(a.token);
    expect(await code(submitProof(pool, storage, c.token, fileA, undefined, { baseUrl: "http://t.local" }))).toBe("not_found"); // berkas diikat ke pembayaran yang memintanya
    const { fileId: ghost } = await requestProofUpload(pool, storage, c.token, { filename: "x.png", mime: "image/png", sizeBytes: 10 });
    expect(await code(submitProof(pool, storage, c.token, ghost, undefined, { baseUrl: "http://t.local" }))).toBe("invalid_input"); // belum diunggah ke penyimpanan
    expect(await pstat(c.paymentId)).toBe("pending");
  });

  it("refund manual: pencatatan oleh admin (tanpa gateway); staf biasa ditolak", async () => {
    const b = await bookDeposit();
    await reviewPayment(deps(), owner(), b.paymentId, { accept: true });
    expect(await code(refundPayment(deps(), { userId: u.staff, slug }, b.paymentId, undefined, "batal"))).toBe("forbidden");
    await refundPayment(deps(), owner(), b.paymentId, undefined, "Dibatalkan oleh penyedia; dana dikembalikan lewat transfer");
    expect(await pstat(b.paymentId)).toBe("refunded");
  });

  it("DB: pelanggan tak dapat menulis metode bayar/bukti; bukti hanya terbaca staf; metode dihapus admin", async () => {
    const b = await bookDeposit();
    const ctx = { userId: "00000000-0000-0000-0000-000000000000", workspaceId: wsId, actor: "public" as const };
    await expect(withTenant(pool, ctx, (db) => db.insert(schema.paymentMethods).values({ workspaceId: wsId, kind: "other", label: "Palsu", instructions: "x" }))).rejects.toThrow();
    await expect(withTenant(pool, ctx, (db) => db.select().from(schema.paymentProofs))).resolves.toHaveLength(0);
    const g = (await pool.query(`SELECT has_table_privilege('jadwalin_app','payment_proofs','INSERT') AS i, has_table_privilege('jadwalin_app','payment_proofs','UPDATE') AS u`)).rows[0];
    expect(g).toEqual({ i: false, u: false });
    const { id } = await savePaymentMethod(pool, owner(), { kind: "other", label: "Hapus aku", instructions: "x" });
    await deletePaymentMethod(pool, owner(), id);
    expect((await listPaymentMethods(pool, owner())).map((m) => m.id)).not.toContain(id);
    void b;
  });
});
