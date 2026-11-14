import {
  AppError, audit, cancelOpenManualPayment, consumeRateLimit, createManualPaymentInTx, hasActivePaymentMethod, freeDays, hashToken, LEGAL_VERSION, listResourceBusyRanges, newToken, normalizePhone, normalizeRecipientKey, notifyEmails, notifyStaff, rateKey, reserveUnit,
  withPublicWorkspace, type StorageAdapter,
} from "@jadwalin/core";
import { asWorker, schema, withTenant } from "@jadwalin/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { dayWindows, rentalWindow, todayLocal } from "./dates";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const RENTAL_LIMITS = { perIpPerHour: 20, perEmailPerDay: 5, perRecipientPerDayGlobal: 15, perWorkspacePerDay: 300, manageActionsPerTokenPerDay: 20 };

export interface PublicProduct {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  pricePerDayIdr: number;
  depositIdr: number;
  /** DP persen dari total sewa (0 = tanpa DP). */
  dpPercent: number;
  units: number;
  hasImage: boolean;
}

const productCols = {
  id: schema.rentalProducts.id, name: schema.rentalProducts.name, category: schema.rentalProducts.category, description: schema.rentalProducts.description,
  pricePerDayIdr: schema.rentalProducts.pricePerDayIdr, depositIdr: schema.rentalProducts.depositIdr, dpPercent: schema.rentalProducts.dpPercent, imageFileId: schema.rentalProducts.imageFileId, units: schema.resources.units,
};
const toPublic = (r: { id: string; name: string; category: string | null; description: string | null; pricePerDayIdr: number; depositIdr: number; dpPercent: number; imageFileId: string | null; units: number }): PublicProduct =>
  ({ id: r.id, name: r.name, category: r.category, description: r.description, pricePerDayIdr: r.pricePerDayIdr, depositIdr: r.depositIdr, dpPercent: r.dpPercent, units: r.units, hasImage: Boolean(r.imageFileId) });

/** Katalog publik. null = halaman tidak ada atau fitur sewa dimatikan. */
export async function listPublicProducts(pool: pg.Pool, slug: string) {
  try {
    return await withPublicWorkspace(pool, slug, async (db, ws) => {
      if (!ws.features.sewa) return null;
      const rows = await db.select(productCols).from(schema.rentalProducts).innerJoin(schema.resources, eq(schema.resources.id, schema.rentalProducts.resourceId)).where(eq(schema.rentalProducts.active, true)).orderBy(asc(schema.rentalProducts.sortOrder), asc(schema.rentalProducts.createdAt));
      return { workspace: { name: ws.name, slug: ws.slug, timezone: ws.timezone, features: ws.features }, products: rows.map(toPublic) };
    });
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  }
}

export async function getPublicProduct(pool: pg.Pool, slug: string, productId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return null;
  const list = await listPublicProducts(pool, slug);
  const product = list?.products.find((p) => p.id === productId);
  return list && product ? { workspace: list.workspace, product } : null;
}

/** Ketersediaan per hari untuk `count` hari (maks 62) mulai `fromDate` di zona usaha. Hari lampau dianggap tidak tersedia. */
export async function getProductAvailability(pool: pg.Pool, slug: string, productId: string, opts: { fromDate: string; count: number; now?: Date }) {
  const now = opts.now ?? new Date();
  const count = Math.max(1, Math.min(62, Math.floor(opts.count)));
  return withPublicWorkspace(pool, slug, async (db, ws) => {
    if (!ws.features.sewa) throw new AppError("not_found", "Halaman tidak ditemukan.");
    const [p] = await db.select({ resourceId: schema.rentalProducts.resourceId, units: schema.resources.units }).from(schema.rentalProducts).innerJoin(schema.resources, eq(schema.resources.id, schema.rentalProducts.resourceId)).where(and(eq(schema.rentalProducts.id, productId), eq(schema.rentalProducts.active, true))).limit(1);
    if (!p) throw new AppError("not_found", "Produk tidak ditemukan.");
    const wins = dayWindows(opts.fromDate, count, ws.timezone);
    const busy = await listResourceBusyRanges(db, p.resourceId, wins[0]!.start, wins[wins.length - 1]!.end);
    const today = todayLocal(now, ws.timezone);
    const free = freeDays(p.units, busy, wins);
    return wins.map((w, i) => ({ date: w.date, available: free[i]! && w.date >= today }));
  });
}

export interface RentalRequestInput { name: string; email?: string; phone?: string; startDate: string; endDate: string; note?: string; privacyAck?: boolean }
export interface RentalRequestOptions { baseUrl: string; clientIdentity?: string; now?: Date }

function validate(input: RentalRequestInput) {
  const name = input.name.replace(/\s+/g, " ").trim();
  const email = (input.email ?? "").trim().toLowerCase() || null;
  const note = (input.note ?? "").trim();
  if (name.length < 2 || name.length > 100) throw new AppError("invalid_input", "Nama harus 2–100 karakter.");
  if (email && (!EMAIL_RE.test(email) || email.length > 200)) throw new AppError("invalid_input", "Alamat email tidak valid.");
  if (note.length > 1000) throw new AppError("invalid_input", "Catatan maksimal 1000 karakter.");
  if (input.privacyAck !== true) throw new AppError("invalid_input", "Centang persetujuan pemberitahuan privasi untuk melanjutkan.");
  // Untuk sewa, nomor HP wajib: pemilik perlu menghubungi penyewa saat serah-terima barang.
  if (!input.phone?.trim()) throw new AppError("invalid_input", "Nomor HP/WhatsApp wajib diisi agar pemilik dapat menghubungi Anda.");
  let phone: string;
  try { phone = normalizePhone(input.phone); } catch { throw new AppError("invalid_input", "Nomor HP tidak valid. Gunakan format 08xx atau +62xx."); }
  return { name, email, phone, note };
}

/** Tamu mengajukan sewa: menahan satu unit (DB mencegah bentrok), membuat pesanan 'pending', dan memberi tahu pelanggan + pemilik. */
export async function requestRental(pool: pg.Pool, slug: string, productId: string, input: RentalRequestInput, opts: RentalRequestOptions) {
  const g = validate(input);
  const now = opts.now ?? new Date();
  const key = slug.toLowerCase();
  if (opts.clientIdentity) await consumeRateLimit(pool, rateKey("rent-ip", opts.clientIdentity), { limit: RENTAL_LIMITS.perIpPerHour, windowSec: 3600, now, message: "Terlalu banyak percobaan dari jaringan Anda. Coba lagi nanti." });
  await consumeRateLimit(pool, rateKey("rent-recipient", g.email ? normalizeRecipientKey(g.email) : `tel:${g.phone}`), { limit: RENTAL_LIMITS.perRecipientPerDayGlobal, windowSec: 86400, now, message: "Alamat email ini sudah menerima terlalu banyak pesan hari ini. Coba lagi besok." });
  await consumeRateLimit(pool, rateKey("rent-email", `${key}|${g.email ? normalizeRecipientKey(g.email) : `tel:${g.phone}`}`), { limit: RENTAL_LIMITS.perEmailPerDay, windowSec: 86400, now, message: "Email ini sudah dipakai mengajukan sewa beberapa kali hari ini. Coba lagi besok." });

  const token = newToken(24);
  const tokenHash = hashToken(token);
  const base = opts.baseUrl.replace(/\/$/, "");

  return withPublicWorkspace(pool, slug, async (db, ws) => {
    if (!ws.features.sewa) throw new AppError("not_found", "Halaman tidak ditemukan.");
    const [p] = await db.select({ ...productCols, resourceId: schema.rentalProducts.resourceId }).from(schema.rentalProducts).innerJoin(schema.resources, eq(schema.resources.id, schema.rentalProducts.resourceId)).where(and(eq(schema.rentalProducts.id, productId), eq(schema.rentalProducts.active, true))).limit(1);
    if (!p) throw new AppError("not_found", "Produk tidak ditemukan.");
    const win = rentalWindow(input.startDate, input.endDate, ws.timezone, now);
    const total = win.days * p.pricePerDayIdr;
    // DP (persen dari total) hanya berlaku bila fitur pembayaran aktif; wajib ada metode bayar aktif SEBELUM unit ditahan (gagal tertutup).
    const dp = ws.features.pembayaran && p.dpPercent > 0 && total > 0 ? Math.min(total, Math.max(1000, Math.round((total * p.dpPercent) / 100))) : 0;
    if (dp > 0 && !(await hasActivePaymentMethod(db, ws.workspaceId))) throw new AppError("payment_unavailable", "Penyedia belum mengatur cara pembayaran DP. Hubungi mereka langsung.");

    // Catatan klien tamu per email (idempoten terhadap pesanan serentak); klien terblokir ditolak.
    const sameGuest = g.email ? sql`lower(${schema.workspaceClients.email}) = ${g.email}` : and(sql`${schema.workspaceClients.email} IS NULL`, eq(schema.workspaceClients.phone, g.phone));
    const findGuest = () => db.select().from(schema.workspaceClients).where(and(sql`${schema.workspaceClients.userId} IS NULL`, sameGuest)).limit(1);
    let [client] = await findGuest();
    if (!client) {
      await db.insert(schema.workspaceClients).values({ workspaceId: ws.workspaceId, userId: null, name: g.name, email: g.email, phone: g.phone, consentVersion: LEGAL_VERSION, consentAt: now }).onConflictDoNothing();
      [client] = await findGuest();
    }
    if (!client || client.blocked) throw new AppError("forbidden", "Tidak dapat memproses permintaan ini.");
    const blocked = await asWorker(db, (w) => w.select({ id: schema.workspaceClients.id }).from(schema.workspaceClients).where(and(eq(schema.workspaceClients.workspaceId, ws.workspaceId), eq(schema.workspaceClients.blocked, true), sameGuest)).limit(1));
    if (blocked.length > 0) throw new AppError("forbidden", "Tidak dapat memproses permintaan ini.");

    await consumeRateLimit(pool, rateKey("rent-ws", key), { limit: RENTAL_LIMITS.perWorkspacePerDay, windowSec: 86400, now, message: "Halaman ini sedang menerima terlalu banyak permintaan. Coba lagi nanti." });

    const r = await reserveUnit(db, { workspaceId: ws.workspaceId, resourceId: p.resourceId, clientId: client.id, startsAt: win.startsAt, endsAt: win.endsAt, tokenHash, notes: g.note });
    const orderId = crypto.randomUUID();
    await db.insert(schema.rentalOrders).values({ id: orderId, workspaceId: ws.workspaceId, reservationId: r.id, productId: p.id, startDate: input.startDate, endDate: input.endDate, days: win.days, pricePerDayIdr: p.pricePerDayIdr, totalIdr: total, dpIdr: dp, customerNote: g.note || null });
    const pay = dp > 0 ? await createManualPaymentInTx(db, { workspaceId: ws.workspaceId, bookingId: r.id, amountIdr: dp, now, subjectType: "reservation" }) : null;
    await audit(db, { workspaceId: ws.workspaceId, actorUserId: null, action: "rental.requested", entityType: "rental_order", entityId: orderId, diff: { productId: p.id, days: win.days, totalIdr: total, dpIdr: dp } });

    const rupiah = `Rp${total.toLocaleString("id-ID")}`;
    // Email berisi tautan kelola yang rahasia: template sensitif (payload dihapus setelah terkirim).
    if (g.email) await notifyEmails(db, ws.workspaceId, [{
      to: g.email, subject: dp > 0 ? `Bayar DP untuk mengunci sewa: ${p.name}` : `Permintaan sewa diterima: ${p.name}`, heading: `Permintaan sewa ${p.name} diterima`,
      paragraphs: [`${input.startDate} s.d. ${input.endDate} (${win.days} hari) · ${rupiah}`, dp > 0 ? `Unit Anda ditahan selama 3 jam. Bayar DP Rp${dp.toLocaleString("id-ID")} lalu unggah buktinya lewat tautan di bawah; pesanan terkonfirmasi setelah ${ws.name} memverifikasinya.` : `${ws.name} akan mengonfirmasi pesanan Anda. Gunakan tautan di bawah untuk melihat status atau membatalkan.`],
      ctaLabel: dp > 0 ? "Bayar DP & unggah bukti" : "Lihat pesanan sewa", url: `${base}/sewa/${token}`, dedupeKey: `rental:${orderId}:requested`, sensitive: true,
    }]);
    await notifyStaff(db, ws.workspaceId, { assigneeMemberId: null }, (to) => ({
      to, subject: `Pesanan sewa baru: ${p.name}`, heading: `Pesanan sewa baru dari ${g.name}`,
      paragraphs: [`${p.name} · ${input.startDate} s.d. ${input.endDate} (${win.days} hari) · ${rupiah}`, `HP: ${g.phone}${g.email ? ` · Email: ${g.email}` : ""}`, ...(dp > 0 ? [`Menunggu DP Rp${dp.toLocaleString("id-ID")} (otomatis dilepas bila tidak dibayar dalam 3 jam).`] : [])],
      ctaLabel: "Buka pesanan", url: `${base}/w/${ws.slug}/sewa`, dedupeKey: `rental:${orderId}:staff:${to}`,
    }));
    return { token, orderId, totalIdr: total, dpIdr: dp, paymentId: pay?.paymentId ?? null, days: win.days };
  });
}

export interface RentalView {
  orderId: string;
  status: string;
  productName: string;
  startDate: string;
  endDate: string;
  days: number;
  totalIdr: number;
  pricePerDayIdr: number;
  depositIdr: number;
  /** DP yang ditagih untuk pesanan ini (0 = tanpa DP). */
  dpIdr: number;
  workspace: { name: string; slug: string };
  workspaceId: string;
  canCancel: boolean;
}

async function loadByToken(pool: pg.Pool, token: string): Promise<(RentalView & { startsAt: Date; clientId: string; reservationId: string }) | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashToken(token);
  return withTenant(pool, { userId: NIL_UUID, actor: "public", bookingTokenHash: tokenHash }, async (db) => {
    const [r] = await db
      .select({
        orderId: schema.rentalOrders.id, reservationId: schema.reservations.id, workspaceId: schema.reservations.workspaceId, status: schema.reservations.status, startsAt: sql<Date>`lower(${schema.reservations.during})`, clientId: schema.reservations.clientId,
        productName: schema.rentalProducts.name, startDate: sql<string>`${schema.rentalOrders.startDate}::text`, endDate: sql<string>`${schema.rentalOrders.endDate}::text`, days: schema.rentalOrders.days,
        totalIdr: schema.rentalOrders.totalIdr, pricePerDayIdr: schema.rentalOrders.pricePerDayIdr, depositIdr: schema.rentalProducts.depositIdr, dpIdr: schema.rentalOrders.dpIdr, wsName: schema.workspaces.name, wsSlug: schema.workspaces.slug,
      })
      .from(schema.reservations)
      .innerJoin(schema.rentalOrders, eq(schema.rentalOrders.reservationId, schema.reservations.id))
      .innerJoin(schema.rentalProducts, eq(schema.rentalProducts.id, schema.rentalOrders.productId))
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.reservations.workspaceId))
      .where(eq(schema.reservations.tokenHash, tokenHash))
      .limit(1);
    if (!r) return null;
    const startsAt = new Date(r.startsAt);
    return {
      orderId: r.orderId, reservationId: r.reservationId, status: r.status, productName: r.productName, startDate: r.startDate, endDate: r.endDate, days: r.days, totalIdr: r.totalIdr, pricePerDayIdr: r.pricePerDayIdr, depositIdr: r.depositIdr, dpIdr: r.dpIdr,
      workspace: { name: r.wsName, slug: r.wsSlug }, workspaceId: r.workspaceId, canCancel: (r.status === "pending" || r.status === "confirmed") && startsAt > new Date(), startsAt, clientId: r.clientId,
    };
  });
}

export async function getRentalByToken(pool: pg.Pool, token: string): Promise<RentalView | null> {
  const v = await loadByToken(pool, token);
  if (!v) return null;
  const { startsAt: _s, clientId: _c, reservationId: _r, ...view } = v;
  void _s; void _c; void _r;
  return view;
}

/** Tamu membatalkan pesanannya sendiri (hanya 'pending'/'confirmed' dan sebelum hari ambil). Unit langsung bebas lagi. */
export async function cancelRentalByToken(pool: pg.Pool, token: string, opts: { baseUrl: string; now?: Date }) {
  const now = opts.now ?? new Date();
  const v = await loadByToken(pool, token);
  if (!v) throw new AppError("not_found", "Pesanan tidak ditemukan.");
  const tokenHash = hashToken(token);
  await consumeRateLimit(pool, rateKey("rent-manage", tokenHash), { limit: RENTAL_LIMITS.manageActionsPerTokenPerDay, windowSec: 86400, now });
  if (!(v.status === "pending" || v.status === "confirmed") || v.startsAt <= now) throw new AppError("invalid_input", v.status === "cancelled" ? "Pesanan ini sudah dibatalkan." : "Pesanan ini sudah tidak bisa dibatalkan.");
  const base = opts.baseUrl.replace(/\/$/, "");
  return withTenant(pool, { userId: NIL_UUID, workspaceId: v.workspaceId, actor: "public", bookingTokenHash: tokenHash }, async (db) => {
    const done = await db.update(schema.reservations).set({ status: "cancelled" }).where(and(eq(schema.reservations.tokenHash, tokenHash), sql`${schema.reservations.status} IN ('pending', 'confirmed')`)).returning({ id: schema.reservations.id });
    if (done.length === 0) throw new AppError("invalid_input", "Pesanan ini sudah dibatalkan.");
    await cancelOpenManualPayment(db, { type: "reservation", id: v.reservationId }, "api", now);
    await audit(db, { workspaceId: v.workspaceId, actorUserId: null, action: "rental.cancelled_by_guest", entityType: "rental_order", entityId: v.orderId });
    await notifyStaff(db, v.workspaceId, { assigneeMemberId: null }, (to) => ({ to, subject: `Pesanan sewa dibatalkan: ${v.productName}`, heading: "Pelanggan membatalkan pesanan sewa", paragraphs: [`${v.productName} · ${v.startDate} s.d. ${v.endDate}`], ctaLabel: "Buka pesanan", url: `${base}/w/${v.workspace.slug}/sewa`, dedupeKey: `rental:${v.orderId}:cancelled:${to}` }));
  });
}

/** URL tampil foto produk (berumur pendek) untuk produk aktif di halaman publik. */
export async function getProductImageUrl(pool: pg.Pool, storage: StorageAdapter, slug: string, productId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(productId)) return null;
  try {
    const f = await withPublicWorkspace(pool, slug, async (db, ws) => {
      if (!ws.features.sewa) return null;
      const [r] = await db.select({ key: schema.files.storageKey, filename: schema.files.filename, mime: schema.files.mime }).from(schema.rentalProducts).innerJoin(schema.files, eq(schema.files.id, schema.rentalProducts.imageFileId)).where(and(eq(schema.rentalProducts.id, productId), eq(schema.rentalProducts.active, true), eq(schema.files.status, "ready"))).limit(1);
      return r ?? null;
    });
    if (!f || !f.mime.startsWith("image/")) return null;
    return await storage.presignDownload({ key: f.key, filename: f.filename, expiresInSec: 300 });
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  }
}
