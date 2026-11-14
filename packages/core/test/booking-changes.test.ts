import { randomUUID } from "node:crypto";
import { createPool, schema, withTenant, withWorker } from "@jadwalin/db";
import { sql } from "drizzle-orm";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError, ManualProvider, S3Storage, acknowledgeRefund, bookPublic, bookingPaymentHooks, cancelBookingByToken, completeRefund, countOpenBookingRequests, createMeetingType, createWorkspace,
  bookingWhatsAppLink, decideBookingRequest, listContactCandidates, getContactPhone, setContactPhone, getBookingByToken, getBookingChangeView, getChangeSettings, getRefundProofUrl, listBookingRequests, listRescheduleSlots, recoverBooking, requestCancellation,
  requestProofUpload, requestRefundProofUpload, requestReschedule, rescheduleBookingByToken, reviewPayment, savePaymentMethod, setChangeSettings, setWeeklyAvailability, submitProof, waLink,
  withdrawRequest, type PaymentDeps,
} from "../src";
import { inviteAndAccept } from "./helpers";

const url = process.env.DATABASE_URL;
const s3 = { endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET, accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY };
const haveS3 = Boolean(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey);
const NOW = new Date("2037-03-02T00:00:00Z"); // Senin
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const BASE = "http://t.local";

describe.skipIf(!url || !haveS3)("perubahan booking: batal + refund, ubah jadwal, pemulihan tautan (ADR 0004)", () => {
  let pool: pg.Pool;
  let storage: S3Storage;
  const sfx = randomUUID().slice(0, 8);
  const u = {} as Record<"owner" | "staff" | "outsider", string>;
  let slug: string;
  let wsId: string;
  const clock = NOW;
  const deps = (): PaymentDeps => ({ pool, provider: new ManualProvider(), now: () => clock, hooks: bookingPaymentHooks({ baseUrl: BASE }) });
  const owner = () => ({ userId: u.owner, slug });
  const staff = () => ({ userId: u.staff, slug });
  let n = 0;
  let si = 0;
  const slot = () => new Date(Date.UTC(2037, 2, 9 + 7 * Math.floor(si / 3), 2 + (si++ % 3)));
  const phone = () => `0813${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const guest = (extra: Record<string, unknown> = {}) => ({ name: "Tamu Ubah", phone: phone(), email: `ubah${++n}-${sfx}@bc.local`, topic: "Konsultasi", startsAt: slot(), privacyAck: true, ...extra }) as Parameters<typeof bookPublic>[3];
  const opts = () => ({ baseUrl: BASE, now: NOW, payments: deps() });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${(e as Error).message}`));
  const bstat = async (id: string) => (await pool.query(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0].status as string;
  const pstat = async (id: string) => (await pool.query(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status as string;
  const mails = async (to: string) => (await pool.query(`SELECT payload->>'subject' AS subject FROM notification_outbox WHERE recipient = $1 ORDER BY created_at`, [to])).rows.map((r) => r.subject as string);

  /** Booking berDP yang sudah dibayar dan diverifikasi (confirmed + payment paid). */
  async function paidBooking(extra: Record<string, unknown> = {}) {
    const g = guest(extra);
    const r = await bookPublic(pool, slug, "berbayar", g, opts());
    const { fileId, upload } = await requestProofUpload(pool, storage, r.manageToken, { filename: "bukti.png", mime: "image/png", sizeBytes: PNG.byteLength });
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: PNG as unknown as BodyInit })).ok).toBe(true);
    await submitProof(pool, storage, r.manageToken, fileId, undefined, { baseUrl: BASE, now: NOW });
    await reviewPayment(deps(), owner(), r.payment!.paymentId, { accept: true });
    expect(await bstat(r.bookingId)).toBe("confirmed");
    return { g, ...r, token: r.manageToken, paymentId: r.payment!.paymentId };
  }
  async function putRefundProof(requestId: string) {
    const { upload } = await requestRefundProofUpload(pool, owner(), storage, requestId, { filename: "refund.png", mime: "image/png", sizeBytes: PNG.byteLength });
    expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: PNG as unknown as BodyInit })).ok).toBe(true);
  }

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    storage = new S3Storage({ endpoint: s3.endpoint!, region: "auto", bucket: s3.bucket!, accessKeyId: s3.accessKeyId!, secretAccessKey: s3.secretAccessKey!, forcePathStyle: true });
    await storage.ensureBucket();
    for (const k of ["owner", "staff", "outsider"] as const) u[k] = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [`${k}-${sfx}@bc.local`, k])).rows[0].id;
    slug = `bc-${sfx}`;
    wsId = (await createWorkspace(pool, u.owner, { name: "Praktik Ubah", slug })).id;
    await createWorkspace(pool, u.outsider, { name: "Lain", slug: `bc-lain-${sfx}` });
    await inviteAndAccept(pool, owner(), { userId: u.staff, email: `staff-${sfx}@bc.local`, role: "staff" });
    await setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    await createMeetingType(pool, owner(), { slug: "berbayar", title: "Konsultasi berbayar", durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 365, locationKind: "link", locationValue: "https://meet.example.com/bc", depositIdr: 100000 });
    await createMeetingType(pool, owner(), { slug: "gratis", title: "Konsultasi gratis", durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 365, locationKind: "link", locationValue: "https://meet.example.com/bc" });
    await savePaymentMethod(pool, owner(), { kind: "bank_transfer", label: "BCA", accountName: "Dewi", accountNumber: "1234567890" });
  });
  afterAll(async () => pool?.end());

  it("tamu TANPA email: cukup nomor HP; nomor yang sama = satu klien; tanpa HP ditolak; tidak ada email terkirim", async () => {
    const phoneNo = phone();
    const a = await bookPublic(pool, slug, "gratis", { name: "Bu Tanpa Email", phone: phoneNo, topic: "Tanya", startsAt: slot(), privacyAck: true }, opts());
    const b = await bookPublic(pool, slug, "gratis", { name: "Bu Tanpa Email", phone: phoneNo, topic: "Tanya lagi", startsAt: slot(), privacyAck: true }, opts());
    const rows = (await pool.query(`SELECT id, email FROM workspace_clients WHERE workspace_id = $1 AND phone = $2`, [wsId, phoneNo.replace(/^0/, "62")])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBeNull();
    expect((await getBookingByToken(pool, a.manageToken))?.noEmail).toBe(true);
    expect((await getBookingByToken(pool, b.manageToken))?.noEmail).toBe(true);
    expect(await code(bookPublic(pool, slug, "gratis", { name: "Tanpa Kontak", topic: "Tanya", startsAt: slot(), privacyAck: true }, opts()))).toBe("invalid_input");
    expect(await code(bookPublic(pool, slug, "gratis", { name: "Salah Email", email: "bukan-email", phone: phone(), topic: "Tanya", startsAt: slot(), privacyAck: true }, opts()))).toBe("invalid_input");
  });

  it("pemulihan tautan: kode booking + nomor HP memutar token; tautan lama mati; salah kode/nomor = pesan sama", async () => {
    const g = guest();
    const r = await bookPublic(pool, slug, "gratis", g, opts());
    const kode = (await getBookingChangeViewCode(r.bookingId))!;
    expect(await code(recoverBooking(pool, slug, { code: kode, phone: phone() }, { now: NOW }))).toBe("invalid_input");
    expect(await code(recoverBooking(pool, slug, { code: "JDW-AAAAAA", phone: g.phone! }, { now: NOW }))).toBe("invalid_input");
    expect(await code(recoverBooking(pool, slug, { code: "ngawur", phone: g.phone! }, { now: NOW }))).toBe("invalid_input");
    expect(await code(recoverBooking(pool, `${slug}-lain`, { code: kode, phone: g.phone! }, { now: NOW }))).toBe("invalid_input");
    const fresh = await recoverBooking(pool, slug, { code: kode.toLowerCase(), phone: g.phone!.replace(/^0/, "+62 ") }, { now: NOW });
    expect(fresh).toBeTruthy();
    expect(await getBookingByToken(pool, r.manageToken)).toBeNull(); // tautan lama berhenti berlaku
    expect((await getBookingByToken(pool, fresh!))?.id).toBe(r.bookingId);
  });

  it("pemulihan juga untuk booking yang sudah DIBATALKAN (pelanggan perlu melihat status refund); hak status worker tidak melebar", async () => {
    const g = guest();
    const r = await bookPublic(pool, slug, "gratis", g, opts());
    await cancelBookingByToken(pool, r.manageToken, { baseUrl: BASE, now: NOW });
    expect(await bstat(r.bookingId)).toBe("cancelled");
    const fresh = await recoverBooking(pool, slug, { code: await getBookingChangeViewCode(r.bookingId), phone: g.phone! }, { now: NOW });
    expect(await getBookingByToken(pool, r.manageToken)).toBeNull();
    expect((await getBookingByToken(pool, fresh))?.status).toBe("cancelled");
    // Role worker tetap hanya boleh mengonfirmasi/membatalkan booking 'pending' (trigger), walau policy baris longgar.
    const g2 = guest();
    const r2 = await bookPublic(pool, slug, "gratis", g2, opts()); // 'confirmed'
    const attempt = await withWorker(pool, (db) => db.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${r2.bookingId}`)).then(() => "ok", () => "ditolak");
    expect(attempt).toBe("ditolak");
    expect(await bstat(r2.bookingId)).toBe("confirmed");
  });

  it("pemulihan dibatasi laju per nomor (tebak-tebakan kode tidak bisa dipakai brute force)", async () => {
    const p = phone();
    const results: string[] = [];
    for (let i = 0; i < 7; i++) results.push(await code(recoverBooking(pool, slug, { code: "JDW-ZZZZZZ", phone: p }, { now: NOW })));
    expect(results.slice(0, 5).every((x) => x === "invalid_input")).toBe(true);
    expect(results.slice(5).every((x) => x === "rate_limited")).toBe(true);
  });

  it("BATAL DENGAN DP: pembatalan langsung ditolak; ajukan → penyedia setuju sebagian → unggah bukti → batal + bukti terlihat pelanggan → pelanggan konfirmasi", async () => {
    const b = await paidBooking();
    expect(await code(cancelBookingByToken(pool, b.token, { baseUrl: BASE, now: NOW }))).toBe("invalid_input");
    expect(await bstat(b.bookingId)).toBe("confirmed");
    expect(await code(requestCancellation(pool, b.token, { reason: "x", refundAccount: "BCA 111 a.n. Tamu" }, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // alasan terlalu pendek
    expect(await code(requestCancellation(pool, b.token, { reason: "Berhalangan hadir", refundAccount: "ab" }, { baseUrl: BASE, now: NOW }))).toBe("invalid_input");

    const { requestId } = await requestCancellation(pool, b.token, { reason: "Berhalangan hadir", refundAccount: "BCA 1112223334 a.n. Tamu Ubah" }, { baseUrl: BASE, now: NOW });
    expect(await bstat(b.bookingId)).toBe("confirmed"); // belum batal sampai disetujui + refund
    expect(await code(requestCancellation(pool, b.token, { reason: "Sekali lagi", refundAccount: "BCA 1112223334 a.n. Tamu" }, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // satu permintaan aktif
    let view = await getBookingChangeView(pool, storage, b.token, NOW);
    expect(view?.paid?.amountIdr).toBe(100000);
    expect(view?.request).toMatchObject({ id: requestId, kind: "cancel", status: "requested", refundProofUrl: null });

    // Staf melihat antrean dan memutuskan.
    expect(await countOpenBookingRequests(pool, staff())).toBeGreaterThanOrEqual(1);
    const row = (await listBookingRequests(pool, staff())).find((r) => r.id === requestId)!;
    expect(row).toMatchObject({ kind: "cancel", status: "requested", clientName: "Tamu Ubah", paidIdr: 100000, refundAccount: "BCA 1112223334 a.n. Tamu Ubah" });
    expect(row.bookingCode).toMatch(/^JDW-/);
    expect(waLink(row.clientPhone, "Halo")).toBe(`https://wa.me/${row.clientPhone}?text=Halo`);
    expect(await code(decideBookingRequest(pool, staff(), requestId, { approve: true, refundAmountIdr: 100001 }, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // melebihi DP
    expect(await code(decideBookingRequest(pool, { userId: u.outsider, slug }, requestId, { approve: true }, { baseUrl: BASE, now: NOW }))).toBe("not_found");
    expect(await code(requestRefundProofUpload(pool, owner(), storage, requestId, { filename: "r.png", mime: "image/png", sizeBytes: 10 }))).toBe("invalid_input"); // belum disetujui
    expect(await decideBookingRequest(pool, staff(), requestId, { approve: true, refundAmountIdr: 60000, note: "Dipotong biaya admin" }, { baseUrl: BASE, now: NOW })).toEqual({ status: "approved" });
    expect(await bstat(b.bookingId)).toBe("confirmed"); // tetap sampai dana dikembalikan
    expect(await code(decideBookingRequest(pool, staff(), requestId, { approve: false, note: "Tidak jadi" }, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // sudah diputuskan
    expect(await code(completeRefund(pool, staff(), storage, requestId, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // belum ada bukti
    expect(await code(withdrawRequest(pool, b.token, { now: NOW }))).toBe("invalid_input"); // sudah disetujui: tidak bisa ditarik

    await putRefundProof(requestId);
    expect(await code(getRefundProofUrl(pool, staff(), storage, requestId))).toBe("not_found"); // belum diselesaikan: berkas belum 'ready'
    expect(await completeRefund(pool, staff(), storage, requestId, { baseUrl: BASE, now: NOW })).toEqual({ status: "completed" });
    expect(await fetchOk((await getRefundProofUrl(pool, staff(), storage, requestId)).url)).toBe(true);
    expect(await bstat(b.bookingId)).toBe("cancelled");
    expect(await pstat(b.paymentId)).toBe("partially_refunded");
    const ev = (await pool.query(`SELECT from_status, to_status FROM payment_events WHERE payment_id = $1 ORDER BY created_at, id`, [b.paymentId])).rows.map((r) => `${r.from_status}>${r.to_status}`);
    expect(ev.at(-1)).toBe("paid>partially_refunded");

    view = await getBookingChangeView(pool, storage, b.token, NOW);
    expect(view?.request).toMatchObject({ status: "completed", refundAmountIdr: 60000, decisionNote: "Dipotong biaya admin", customerAck: null });
    expect(view?.request?.refundProofUrl).toMatch(/^https?:\/\//);
    expect(await fetchOk(view!.request!.refundProofUrl!)).toBe(true);
    expect(await mails(b.g.email!)).toEqual(expect.arrayContaining(["Pengajuan pembatalan diterima: Konsultasi berbayar", "Pembatalan disetujui: Konsultasi berbayar", "Dana dikembalikan: Konsultasi berbayar"]));

    await acknowledgeRefund(pool, b.token, "received", { baseUrl: BASE, now: NOW });
    expect((await getBookingChangeView(pool, storage, b.token, NOW))?.request?.customerAck).toBe("received");
    // Bukti refund tidak bisa dibaca penyedia lain maupun pengunjung tanpa token.
    expect(await code(getRefundProofUrl(pool, { userId: u.outsider, slug }, storage, requestId))).toBe("not_found");
    expect(await getBookingChangeView(pool, storage, "token-ngawur", NOW)).toBeNull();
  });

  it("BATAL DENGAN DP ditolak penyedia → booking tetap berlaku; pelanggan dapat memberi tahu 'belum diterima' bila refund tak masuk", async () => {
    const b = await paidBooking();
    const { requestId } = await requestCancellation(pool, b.token, { reason: "Mau ganti rencana", refundAccount: "GoPay 0812 a.n. Tamu" }, { baseUrl: BASE, now: NOW });
    expect(await code(decideBookingRequest(pool, staff(), requestId, { approve: false, note: "" }, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // alasan wajib
    await decideBookingRequest(pool, staff(), requestId, { approve: false, note: "DP tidak dapat dikembalikan" }, { baseUrl: BASE, now: NOW });
    expect(await bstat(b.bookingId)).toBe("confirmed");
    expect(await pstat(b.paymentId)).toBe("paid");
    expect((await getBookingChangeView(pool, storage, b.token, NOW))?.request).toMatchObject({ status: "rejected", decisionNote: "DP tidak dapat dikembalikan" });
    // Setelah ditolak, pelanggan boleh mengajukan lagi.
    const again = await requestCancellation(pool, b.token, { reason: "Sakit, ada surat dokter", refundAccount: "GoPay 0812 a.n. Tamu" }, { baseUrl: BASE, now: NOW });
    // Disetujui tanpa refund (Rp0): booking langsung batal, DP tetap tercatat terbayar.
    expect(await decideBookingRequest(pool, staff(), again.requestId, { approve: true, refundAmountIdr: 0 }, { baseUrl: BASE, now: NOW })).toEqual({ status: "completed" });
    expect(await bstat(b.bookingId)).toBe("cancelled");
    expect(await pstat(b.paymentId)).toBe("paid");
    expect(await code(acknowledgeRefund(pool, b.token, "received", { baseUrl: BASE, now: NOW }))).toBe("ok"); // tercatat (tanpa refund, tak ada yang dikonfirmasi bermakna, tetapi tidak merusak)
  });

  it("pelanggan menarik permintaan yang belum diputuskan; 'belum diterima' memberi tahu penyedia", async () => {
    const b = await paidBooking();
    const { requestId } = await requestCancellation(pool, b.token, { reason: "Ragu-ragu dulu", refundAccount: "BCA 999 a.n. Tamu" }, { baseUrl: BASE, now: NOW });
    await withdrawRequest(pool, b.token, { now: NOW });
    expect((await listBookingRequests(pool, staff(), "all")).some((r) => r.id === requestId)).toBe(false);
    expect((await getBookingChangeView(pool, storage, b.token, NOW))?.request).toBeNull();

    const c = await paidBooking();
    const r2 = await requestCancellation(pool, c.token, { reason: "Batal saja ya", refundAccount: "BCA 888 a.n. Tamu" }, { baseUrl: BASE, now: NOW });
    await decideBookingRequest(pool, owner(), r2.requestId, { approve: true }, { baseUrl: BASE, now: NOW }); // refund penuh bawaan
    await putRefundProof(r2.requestId);
    await completeRefund(pool, owner(), storage, r2.requestId, { baseUrl: BASE, now: NOW });
    expect(await pstat(c.paymentId)).toBe("refunded");
    await acknowledgeRefund(pool, c.token, "not_received", { baseUrl: BASE, now: NOW });
    expect((await pool.query(`SELECT 1 FROM notification_outbox WHERE workspace_id = $1 AND payload->>'subject' LIKE 'Pelanggan belum menerima refund%'`, [wsId])).rowCount).toBeGreaterThanOrEqual(1);
    expect((await listBookingRequests(pool, staff(), "all")).find((r) => r.id === r2.requestId)?.customerAck).toBe("not_received");
  });

  it("UBAH JADWAL: mode otomatis tetap langsung; mode persetujuan butuh permintaan → setuju memindahkan, tolak membiarkan", async () => {
    const g = guest();
    const r = await bookPublic(pool, slug, "gratis", g, opts());
    const slots = (await listRescheduleSlots(pool, r.manageToken, NOW))!;
    expect(await code(requestReschedule(pool, r.manageToken, slots[3]!.start, {}, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // mode otomatis: tidak perlu permintaan
    await rescheduleBookingByToken(pool, r.manageToken, slots[0]!.start, { baseUrl: BASE, now: NOW });

    await setChangeSettings(pool, owner(), { rescheduleMode: "approval", changeMinHours: 0 });
    expect(await getChangeSettings(pool, staff())).toEqual({ rescheduleMode: "approval", changeMinHours: 0 });
    expect(await code(setChangeSettings(pool, staff(), { rescheduleMode: "auto", changeMinHours: 0 }))).toBe("forbidden");
    expect(await code(rescheduleBookingByToken(pool, r.manageToken, slots[1]!.start, { baseUrl: BASE, now: NOW }))).toBe("invalid_input");
    const before = (await getBookingByToken(pool, r.manageToken, NOW))!.startsAt.getTime();
    expect(await code(requestReschedule(pool, r.manageToken, new Date("2037-03-10T10:00:00Z"), {}, { baseUrl: BASE, now: NOW }))).toBe("slot_unavailable"); // bukan slot sah

    const { requestId } = await requestReschedule(pool, r.manageToken, slots[2]!.start, { note: "Ada rapat mendadak" }, { baseUrl: BASE, now: NOW });
    expect((await getBookingByToken(pool, r.manageToken, NOW))!.startsAt.getTime()).toBe(before); // jadwal lama tetap
    expect((await getBookingChangeView(pool, storage, r.manageToken, NOW))?.request).toMatchObject({ kind: "reschedule", status: "requested", newStartsAt: slots[2]!.start });
    expect(await decideBookingRequest(pool, staff(), requestId, { approve: true }, { baseUrl: BASE, now: NOW })).toEqual({ status: "completed" });
    expect((await getBookingByToken(pool, r.manageToken, NOW))!.startsAt.getTime()).toBe(slots[2]!.start.getTime());
    expect(await mails(g.email!)).toContain("Jadwal diubah: Konsultasi gratis");

    const { requestId: r2 } = await requestReschedule(pool, r.manageToken, slots[3]!.start, {}, { baseUrl: BASE, now: NOW });
    await decideBookingRequest(pool, staff(), r2, { approve: false, note: "Slot itu untuk klien tetap" }, { baseUrl: BASE, now: NOW });
    expect((await getBookingByToken(pool, r.manageToken, NOW))!.startsAt.getTime()).toBe(slots[2]!.start.getTime());
    await setChangeSettings(pool, owner(), { rescheduleMode: "auto", changeMinHours: 0 });
  });

  it("BATAS WAKTU: dalam jendela 'paling lambat N jam sebelum' pelanggan tidak bisa batal/ubah sendiri", async () => {
    await setChangeSettings(pool, owner(), { rescheduleMode: "auto", changeMinHours: 24 });
    const g = guest({ startsAt: new Date(Date.UTC(2037, 2, 2, 3)) }); // Senin 10.00 WIB, hanya 3 jam dari NOW
    const r = await bookPublic(pool, slug, "gratis", g, opts());
    expect(await code(cancelBookingByToken(pool, r.manageToken, { baseUrl: BASE, now: NOW }))).toBe("invalid_input");
    expect(await code(rescheduleBookingByToken(pool, r.manageToken, new Date(Date.UTC(2037, 2, 16, 3)), { baseUrl: BASE, now: NOW }))).toBe("invalid_input");
    expect((await getBookingChangeView(pool, storage, r.manageToken, NOW))?.policy).toMatchObject({ changeMinHours: 24, windowOpen: false });
    expect(await code(setChangeSettings(pool, owner(), { rescheduleMode: "auto", changeMinHours: 9999 }))).toBe("invalid_input");
    await setChangeSettings(pool, owner(), { rescheduleMode: "auto", changeMinHours: 0 });
    expect(await code(cancelBookingByToken(pool, r.manageToken, { baseUrl: BASE, now: NOW }))).toBe("ok");
  });

  it("tanpa DP: pembatalan langsung tetap berjalan dan membatalkan tagihan DP yang masih terbuka", async () => {
    const g = guest();
    const r = await bookPublic(pool, slug, "berbayar", g, opts()); // belum dibayar
    expect(await code(requestCancellation(pool, r.manageToken, { reason: "Batal saja", refundAccount: "BCA 12345 a.n. T" }, { baseUrl: BASE, now: NOW }))).toBe("invalid_input"); // tak ada DP terbayar
    await cancelBookingByToken(pool, r.manageToken, { baseUrl: BASE, now: NOW });
    expect(await bstat(r.bookingId)).toBe("cancelled");
    expect(await pstat(r.payment!.paymentId)).toBe("cancelled");
  });

  it("HUBUNGI LANGSUNG + PINTASAN WA: nomor WhatsApp usaha tervalidasi dan terlihat pemegang tautan; pintasan penyedia hanya tautan wa.me", async () => {
    expect(await code(setContactPhone(pool, owner(), "abc"))).toBe("invalid_input");
    expect(await code(setContactPhone(pool, staff(), "0812-3333-4444"))).toBe("forbidden"); // hanya admin ke atas
    await setContactPhone(pool, owner(), "0812-3333-4444");
    expect(await getContactPhone(pool, staff())).toBe("6281233334444");
    const g = guest();
    const r = await bookPublic(pool, slug, "gratis", g, opts());
    const seen = await getBookingByToken(pool, r.manageToken, NOW);
    expect(seen?.workspace.contactPhone).toBe("6281233334444");
    expect(seen?.clientName).toBe("Tamu Ubah");
    // Pintasan penyedia: murni tautan wa.me ke nomor pelanggan; tidak mengubah apa pun (tautan lama tetap hidup).
    const wa = bookingWhatsAppLink({ phone: g.phone!.replace(/^0/, "62"), clientName: "Tamu Ubah", wsName: "Praktik Ubah", wsSlug: slug, typeTitle: "Konsultasi gratis", startsAt: seen!.startsAt, timezone: "Asia/Jakarta", bookingId: r.bookingId, baseUrl: BASE });
    expect(wa.startsWith(`https://wa.me/${g.phone!.replace(/^0/, "62")}?text=`)).toBe(true);
    const decoded = decodeURIComponent(wa);
    expect(decoded).toContain(`http://t.local/booking/cari?u=${slug}&kode=`);
    expect(decoded).toContain("JDW-");
    expect((await getBookingByToken(pool, r.manageToken, NOW))?.id).toBe(r.bookingId);
    await pool.query(`UPDATE users SET phone = $1 WHERE id = $2`, [`62813${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, u.staff]);
    const cands = await listContactCandidates(pool, owner());
    expect(cands.some((c) => c.name === "staff" && c.role === "staff")).toBe(true); // nomor anggota tim bisa dipilih
    expect(cands.every((c) => /^62\d+$/.test(c.phone))).toBe(true);
    expect(await code(listContactCandidates(pool, staff()))).toBe("forbidden");
    expect(await code(setContactPhone(pool, owner(), ""))).toBe("invalid_input"); // nomor wajib, tidak bisa dikosongkan
    expect(await getContactPhone(pool, staff())).toBe("6281233334444");
    const w2 = await createWorkspace(pool, u.owner, { name: "Usaha Berkontak", slug: `bc-kontak-${sfx}`, contactPhone: "0812-9999-0001" });
    expect((await pool.query(`SELECT contact_phone FROM workspaces WHERE id = $1`, [w2.id])).rows[0].contact_phone).toBe("6281299990001");
    expect(await code(createWorkspace(pool, u.owner, { name: "Usaha Salah", slug: `bc-salah-${sfx}`, contactPhone: "abc" }))).toBe("invalid_input");
  });

  it("RLS: pengunjung/klien tidak bisa membaca atau menulis permintaan langsung; penyedia lain tidak melihatnya", async () => {
    const mine = await pool.query(`SELECT count(*)::int AS n FROM booking_requests WHERE workspace_id = $1`, [wsId]);
    expect(mine.rows[0].n).toBeGreaterThan(0);
    const NIL = "00000000-0000-0000-0000-000000000000";
    const asPublic = await withTenant(pool, { userId: NIL, workspaceId: wsId, actor: "public" }, (db) => db.select().from(schema.bookingRequests)).catch(() => "ditolak");
    expect(asPublic === "ditolak" || (Array.isArray(asPublic) && asPublic.length === 0)).toBe(true);
    const asClient = await withTenant(pool, { userId: u.outsider, workspaceId: wsId, actor: "client" }, (db) => db.select().from(schema.bookingRequests)).catch(() => "ditolak");
    expect(asClient === "ditolak" || (Array.isArray(asClient) && asClient.length === 0)).toBe(true);
    expect(await code(listBookingRequests(pool, { userId: u.outsider, slug }))).toBe("not_found");
    const other = (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [`bc-lain-${sfx}`])).rows[0].id as string;
    const leak = await withTenant(pool, { userId: u.outsider, workspaceId: other }, (db) => db.select().from(schema.bookingRequests));
    expect(leak).toHaveLength(0);
  });

  async function getBookingChangeViewCode(bookingId: string) {
    const { bookingCode } = await import("../src");
    return bookingCode(bookingId);
  }
  async function fetchOk(u2: string) {
    return (await fetch(u2)).ok;
  }
});
