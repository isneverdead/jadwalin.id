import { AppError, audit, cancelOpenManualPayment, createPendingFile, paymentStatusBySubject, createResourceInTx, notifyEmails, requireFeature, setReservationStatusInTx, type StorageAdapter, updateResourceInTx, withWorkspace, type Actor, type ReservationStatus } from "@jadwalin/core";
import { schema, type Db } from "@jadwalin/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { todayLocal } from "./dates";

export const MAX_PRODUCTS = 100;
export interface ProductInput { name: string; category?: string; description?: string; pricePerDayIdr: number; depositIdr?: number; /** DP dalam persen (0–100) dari total sewa; 0 = tanpa DP. */ dpPercent?: number; units: number; imageFileId?: string | null }

function clean(input: ProductInput) {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) throw new AppError("invalid_input", "Nama produk 2–80 karakter.");
  const category = (input.category ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
  const description = (input.description ?? "").trim().slice(0, 2000) || null;
  const price = Number(input.pricePerDayIdr);
  const deposit = Number(input.depositIdr ?? 0);
  if (!Number.isInteger(price) || price < 0 || price > 1_000_000_000) throw new AppError("invalid_input", "Harga per hari harus bilangan bulat Rupiah (0–1.000.000.000).");
  if (!Number.isInteger(deposit) || deposit < 0 || deposit > 1_000_000_000) throw new AppError("invalid_input", "Uang jaminan harus bilangan bulat Rupiah.");
  const dpPercent = Number(input.dpPercent ?? 0);
  if (!Number.isInteger(dpPercent) || dpPercent < 0 || dpPercent > 100) throw new AppError("invalid_input", "DP harus bilangan bulat 0–100 persen.");
  if (!Number.isInteger(input.units) || input.units < 1 || input.units > 50) throw new AppError("invalid_input", "Jumlah unit 1–50.");
  return { name, category, description, price, deposit, dpPercent, units: input.units };
}

/** Foto produk harus berkas gambar siap pakai milik usaha ini (FK Postgres tidak melewati RLS, jadi dicek eksplisit). */
async function assertImage(db: Db, fileId: string | null | undefined): Promise<string | null> {
  if (!fileId) return null;
  const [f] = await db.select({ id: schema.files.id, mime: schema.files.mime, status: schema.files.status }).from(schema.files).where(eq(schema.files.id, fileId)).limit(1);
  if (!f || f.status !== "ready" || !f.mime.startsWith("image/")) throw new AppError("invalid_input", "Foto produk harus berkas gambar yang sudah selesai diunggah.");
  return f.id;
}

export async function createProduct(pool: pg.Pool, actor: Actor, input: ProductInput) {
  const v = clean(input);
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    await requireFeature(db, access, "sewa");
    if (v.dpPercent > 0) await requireFeature(db, access, "pembayaran");
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.rentalProducts)) as [{ n: number }];
    if (n >= MAX_PRODUCTS) throw new AppError("invalid_input", `Maksimal ${MAX_PRODUCTS} produk.`);
    const imageFileId = await assertImage(db, input.imageFileId);
    const resourceId = await createResourceInTx(db, access.workspaceId, { name: v.name, units: v.units });
    const id = randomUUID();
    await db.insert(schema.rentalProducts).values({ id, workspaceId: access.workspaceId, resourceId, name: v.name, category: v.category, description: v.description, pricePerDayIdr: v.price, depositIdr: v.deposit, dpPercent: v.dpPercent, imageFileId, sortOrder: n });
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "rental_product.created", entityType: "rental_product", entityId: id, diff: { name: v.name, pricePerDayIdr: v.price, units: v.units } });
    return { id };
  });
}

export async function updateProduct(pool: pg.Pool, actor: Actor, productId: string, input: ProductInput) {
  const v = clean(input);
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    await requireFeature(db, access, "sewa");
    if (v.dpPercent > 0) await requireFeature(db, access, "pembayaran");
    const [p] = await db.select({ resourceId: schema.rentalProducts.resourceId, imageFileId: schema.rentalProducts.imageFileId }).from(schema.rentalProducts).where(eq(schema.rentalProducts.id, productId)).limit(1);
    if (!p) throw new AppError("not_found", "Produk tidak ditemukan.");
    // Foto: kosong = tetap; berisi = ganti (harus berkas gambar usaha ini).
    const imageFileId = input.imageFileId ? await assertImage(db, input.imageFileId) : p.imageFileId;
    await updateResourceInTx(db, p.resourceId, { name: v.name, units: v.units });
    await db.update(schema.rentalProducts).set({ name: v.name, category: v.category, description: v.description, pricePerDayIdr: v.price, depositIdr: v.deposit, dpPercent: v.dpPercent, imageFileId }).where(eq(schema.rentalProducts.id, productId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "rental_product.updated", entityType: "rental_product", entityId: productId, diff: { name: v.name, pricePerDayIdr: v.price, units: v.units } });
  });
}

export async function setProductActive(pool: pg.Pool, actor: Actor, productId: string, active: boolean) {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    await requireFeature(db, access, "sewa");
    const [p] = await db.select({ resourceId: schema.rentalProducts.resourceId }).from(schema.rentalProducts).where(eq(schema.rentalProducts.id, productId)).limit(1);
    if (!p) throw new AppError("not_found", "Produk tidak ditemukan.");
    await db.update(schema.rentalProducts).set({ active }).where(eq(schema.rentalProducts.id, productId));
    await updateResourceInTx(db, p.resourceId, { active });
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: active ? "rental_product.activated" : "rental_product.deactivated", entityType: "rental_product", entityId: productId });
  });
}

export async function listProducts(pool: pg.Pool, actor: Actor) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    await requireFeature(db, access, "sewa");
    return db
      .select({ id: schema.rentalProducts.id, name: schema.rentalProducts.name, category: schema.rentalProducts.category, description: schema.rentalProducts.description, pricePerDayIdr: schema.rentalProducts.pricePerDayIdr, depositIdr: schema.rentalProducts.depositIdr, dpPercent: schema.rentalProducts.dpPercent, active: schema.rentalProducts.active, imageFileId: schema.rentalProducts.imageFileId, units: schema.resources.units })
      .from(schema.rentalProducts)
      .innerJoin(schema.resources, eq(schema.resources.id, schema.rentalProducts.resourceId))
      .orderBy(schema.rentalProducts.sortOrder, schema.rentalProducts.createdAt);
  });
}

export interface OrderRow {
  id: string;
  reservationId: string;
  status: string;
  unitNo: number;
  productName: string;
  clientName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  startDate: string;
  endDate: string;
  days: number;
  totalIdr: number;
  dpIdr: number;
  /** Status DP (pembayaran manual): null bila pesanan tanpa DP. */
  dpStatus: string | null;
  customerNote: string | null;
  createdAt: Date;
}

export async function listOrders(pool: pg.Pool, actor: Actor, filter: "open" | "all" = "open"): Promise<OrderRow[]> {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    await requireFeature(db, access, "sewa");
    const rows = await db
      .select({
        id: schema.rentalOrders.id, reservationId: schema.rentalOrders.reservationId, status: schema.reservations.status, unitNo: schema.reservations.unitNo,
        productName: schema.rentalProducts.name, clientName: schema.workspaceClients.name, clientEmail: schema.workspaceClients.email, clientPhone: schema.workspaceClients.phone,
        startDate: sql<string>`${schema.rentalOrders.startDate}::text`, endDate: sql<string>`${schema.rentalOrders.endDate}::text`, days: schema.rentalOrders.days,
        totalIdr: schema.rentalOrders.totalIdr, dpIdr: schema.rentalOrders.dpIdr, customerNote: schema.rentalOrders.customerNote, createdAt: schema.rentalOrders.createdAt,
      })
      .from(schema.rentalOrders)
      .innerJoin(schema.reservations, eq(schema.reservations.id, schema.rentalOrders.reservationId))
      .innerJoin(schema.rentalProducts, eq(schema.rentalProducts.id, schema.rentalOrders.productId))
      .leftJoin(schema.workspaceClients, eq(schema.workspaceClients.id, schema.reservations.clientId))
      .where(filter === "open" ? inArray(schema.reservations.status, ["pending", "confirmed", "active"]) : sql`true`)
      .orderBy(sql`(${schema.reservations.status} = 'pending') desc`, desc(schema.rentalOrders.createdAt))
      .limit(200);
    const pay = await paymentStatusBySubject(db, "reservation", rows.map((r) => r.reservationId));
    return rows.map((r) => ({ ...r, dpStatus: pay.get(r.reservationId)?.status ?? null }));
  });
}

const STATUS_TEXT: Partial<Record<ReservationStatus, { subject: string; heading: string; body: string }>> = {
  confirmed: { subject: "Pesanan sewa dikonfirmasi", heading: "Pesanan sewa Anda dikonfirmasi", body: "Pemilik telah mengonfirmasi pesanan Anda. Siapkan identitas saat mengambil barang." },
  rejected: { subject: "Pesanan sewa tidak dapat dipenuhi", heading: "Maaf, pesanan sewa Anda tidak dapat dipenuhi", body: "Pemilik tidak dapat memenuhi pesanan ini. Silakan pilih tanggal lain atau hubungi pemilik." },
  cancelled: { subject: "Pesanan sewa dibatalkan", heading: "Pesanan sewa Anda dibatalkan", body: "Pesanan ini dibatalkan oleh pemilik. Hubungi pemilik bila ada pertanyaan." },
};

export async function setOrderStatus(pool: pg.Pool, actor: Actor, orderId: string, to: ReservationStatus, opts: { baseUrl: string }) {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    await requireFeature(db, access, "sewa");
    const [o] = await db
      .select({ reservationId: schema.rentalOrders.reservationId, depositIdr: schema.rentalProducts.depositIdr, productName: schema.rentalProducts.name, start: sql<string>`${schema.rentalOrders.startDate}::text`, end: sql<string>`${schema.rentalOrders.endDate}::text`, clientEmail: schema.workspaceClients.email, wsName: schema.workspaces.name })
      .from(schema.rentalOrders)
      .innerJoin(schema.reservations, eq(schema.reservations.id, schema.rentalOrders.reservationId))
      .innerJoin(schema.rentalProducts, eq(schema.rentalProducts.id, schema.rentalOrders.productId))
      .innerJoin(schema.workspaceClients, eq(schema.workspaceClients.id, schema.reservations.clientId))
      .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.rentalOrders.workspaceId))
      .where(eq(schema.rentalOrders.id, orderId))
      .limit(1);
    if (!o) throw new AppError("not_found", "Pesanan tidak ditemukan.");
    // DP yang masih terbuka: konfirmasi lewat verifikasi bukti di menu Pembayaran (bukan lewat tombol ini); batal/tolak ikut membatalkan tagihan DP.
    const pay = (await paymentStatusBySubject(db, "reservation", [o.reservationId])).get(o.reservationId);
    if (to === "confirmed" && pay && (pay.status === "pending" || pay.status === "awaiting_verification")) {
      throw new AppError("invalid_input", "Pesanan ini menunggu DP. Verifikasi bukti DP di menu Pembayaran; pesanan otomatis terkonfirmasi setelah DP dinyatakan lunas, atau tandai lunas bila DP dibayar tunai.");
    }
    await setReservationStatusInTx(db, access, actor.userId, o.reservationId, to);
    if (to === "cancelled" || to === "rejected") await cancelOpenManualPayment(db, { type: "reservation", id: o.reservationId }, "admin");
    const t = STATUS_TEXT[to];
    const jaminan = to === "confirmed" && o.depositIdr > 0 ? `Siapkan juga uang jaminan Rp${o.depositIdr.toLocaleString("id-ID")} (dikembalikan saat barang kembali).` : null;
    if (t && o.clientEmail) {
      await notifyEmails(db, access.workspaceId, [{ to: o.clientEmail, subject: `${t.subject}: ${o.productName}`, heading: t.heading, paragraphs: [`${o.productName} · ${o.start} s.d. ${o.end}`, t.body, ...(jaminan ? [jaminan] : [])], ctaLabel: "Buka jadwalin.id", url: opts.baseUrl, dedupeKey: `rental:${orderId}:${to}` }]);
    }
  });
}

export async function countPendingOrders(pool: pg.Pool, actor: Actor): Promise<number> {
  return withWorkspace(pool, actor, "staff", async (db) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.reservations).innerJoin(schema.rentalOrders, eq(schema.rentalOrders.reservationId, schema.reservations.id)).where(and(eq(schema.reservations.status, "pending")));
    return r?.n ?? 0;
  });
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Foto produk: jalur unggah sendiri (tidak bergantung pada fitur Berkas), hanya gambar ≤ 5 MB, lewat modul berkas core. */
export async function requestProductImageUpload(pool: pg.Pool, actor: Actor, storage: StorageAdapter, req: { filename: string; mime: string; sizeBytes: number }) {
  if (!IMAGE_MIMES.has(req.mime)) throw new AppError("invalid_input", "Foto produk harus PNG, JPG, atau WebP.");
  if (!Number.isInteger(req.sizeBytes) || req.sizeBytes <= 0 || req.sizeBytes > MAX_IMAGE_BYTES) throw new AppError("invalid_input", "Foto produk maksimal 5 MB.");
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    await requireFeature(db, access, "sewa");
    return createPendingFile(db, access, storage, actor.userId, req);
  });
}

export interface RentalStats { pending: number; confirmed: number; active: number; pickupsToday: number; returnsToday: number; products: number; activeProducts: number }

/** Ringkasan untuk dasbor: pesanan menunggu, terkonfirmasi, sedang disewa, serta ambil/kembali hari ini (zona usaha). */
export async function getRentalStats(pool: pg.Pool, actor: Actor, opts: { now?: Date } = {}): Promise<RentalStats> {
  return withWorkspace(pool, actor, "staff", async (db, access) => {
    await requireFeature(db, access, "sewa");
    const [ws] = await db.select({ tz: schema.workspaces.timezone }).from(schema.workspaces).where(eq(schema.workspaces.id, access.workspaceId)).limit(1);
    const today = todayLocal(opts.now ?? new Date(), ws?.tz ?? "Asia/Jakarta");
    const [o] = await db
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${schema.reservations.status} = 'pending')::int`,
        confirmed: sql<number>`count(*) FILTER (WHERE ${schema.reservations.status} = 'confirmed')::int`,
        active: sql<number>`count(*) FILTER (WHERE ${schema.reservations.status} = 'active')::int`,
        pickupsToday: sql<number>`count(*) FILTER (WHERE ${schema.reservations.status} = 'confirmed' AND ${schema.rentalOrders.startDate} = ${today}::date)::int`,
        returnsToday: sql<number>`count(*) FILTER (WHERE ${schema.reservations.status} = 'active' AND ${schema.rentalOrders.endDate} = ${today}::date)::int`,
      })
      .from(schema.rentalOrders)
      .innerJoin(schema.reservations, eq(schema.reservations.id, schema.rentalOrders.reservationId));
    const [pr] = await db.select({ total: sql<number>`count(*)::int`, active: sql<number>`count(*) FILTER (WHERE ${schema.rentalProducts.active})::int` }).from(schema.rentalProducts);
    return { pending: o?.pending ?? 0, confirmed: o?.confirmed ?? 0, active: o?.active ?? 0, pickupsToday: o?.pickupsToday ?? 0, returnsToday: o?.returnsToday ?? 0, products: pr?.total ?? 0, activeProducts: pr?.active ?? 0 };
  });
}
