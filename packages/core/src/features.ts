import { schema, type Db } from "@jadwalin/db";
import { eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import { AppError } from "./errors";
import { audit, withWorkspace, type Actor, type WorkspaceRef } from "./workspace";

/**
 * Fitur yang bisa dinyalakan/dimatikan per usaha. "jadwal" (janji temu per jam) boleh dimatikan untuk usaha sewa-per-hari,
 * tetapi minimal satu dari jadwal/sewa harus aktif; log audit selalu aktif (keamanan, tidak boleh dimatikan).
 */
export const FEATURE_KEYS = ["jadwal", "tiket", "pembayaran", "berkas", "sewa"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;

export const FEATURE_INFO: Record<FeatureKey, { label: string; description: string; offHint: string }> = {
  jadwal: {
    label: "Janji temu per jam",
    description: "Jam kerja mingguan dan layanan yang dipesan pelanggan pada jam tertentu (konsultasi, perawatan, les).",
    offHint: "Matikan bila usaha Anda menyewakan barang per hari (rental mobil/motor) dan tidak menerima janji temu per jam.",
  },
  tiket: {
    label: "Tiket & pesan klien",
    description: "Klien mengirim pertanyaan/permintaan, Anda membalas, melampirkan berkas, dan menjadwalkan meeting dari satu percakapan.",
    offHint: "Cocok dimatikan bila pelanggan cukup memesan jadwal lalu datang (salon, barbershop, sewa lapangan).",
  },
  pembayaran: {
    label: "DP & pembayaran manual",
    description: "Pelanggan membayar DP langsung ke rekening/QRIS Anda dan mengirim bukti; Anda yang memverifikasi. jadwalin.id tidak memproses uang.",
    offHint: "Matikan bila Anda menerima pembayaran di tempat atau layanannya gratis.",
  },
  sewa: {
    label: "Katalog produk & sewa barang",
    description: "Pasang produk yang bisa disewa (mobil, motor, kamera, alat pesta), lengkap dengan foto dan harga per hari. Pelanggan memilih tanggal; sistem mencegah dua orang menyewa unit yang sama.",
    offHint: "Nyalakan bila usaha Anda menyewakan barang, bukan melayani janji temu.",
  },
  berkas: {
    label: "Penyimpanan berkas",
    description: "Simpan dokumen (materi, template, formulir) dan unduh lewat tautan sementara.",
    offHint: "Matikan bila tidak menyimpan dokumen, misalnya untuk menghindari menyimpan data sensitif.",
  },
};

/** Sewa mati secara bawaan: halaman lama tidak tiba-tiba punya menu produk; usaha rental menyalakannya lewat template. */
export const DEFAULT_FEATURES: Features = { jadwal: true, tiket: true, pembayaran: true, berkas: true, sewa: false };

/** Membaca jsonb apa adanya: kunci yang hilang = aktif (usaha lama), nilai non-boolean diabaikan. */
export function parseFeatures(raw: unknown): Features {
  const out = { ...DEFAULT_FEATURES };
  if (raw && typeof raw === "object") {
    for (const k of FEATURE_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

export async function getFeaturesInTx(db: Db, workspaceId: string): Promise<Features> {
  const [row] = await db.select({ features: schema.workspaces.features }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  return parseFeatures(row?.features);
}

/** Penegakan di server: dipanggil dari fungsi yang menyentuh fitur, bukan hanya menyembunyikan menu. */
export async function requireFeature(db: Db, access: WorkspaceRef, key: FeatureKey): Promise<void> {
  const f = await getFeaturesInTx(db, access.workspaceId);
  if (!f[key]) throw new AppError("feature_disabled", `Fitur “${FEATURE_INFO[key].label}” dimatikan untuk halaman ini. Nyalakan di menu Pengaturan.`);
}

export async function getFeatures(pool: pg.Pool, actor: Actor): Promise<Features> {
  return withWorkspace(pool, actor, "staff", (db, access) => getFeaturesInTx(db, access.workspaceId));
}

/** Bentuk input form → Features lengkap (kunci tak dikenal dibuang). */
export function featuresFromInput(input: Partial<Record<string, unknown>>): Features {
  const out = { ...DEFAULT_FEATURES };
  for (const k of FEATURE_KEYS) out[k] = input[k] === true || input[k] === "on" || input[k] === "true";
  return out;
}

/**
 * Mengubah fitur (admin/pemilik). Mematikan "pembayaran" ditolak selama masih ada layanan aktif ber-DP
 * atau pembayaran yang belum selesai, supaya tidak ada uang/bukti pelanggan yang "menggantung" tanpa menu.
 */
export async function setFeatures(pool: pg.Pool, actor: Actor, next: Features): Promise<Features> {
  return withWorkspace(pool, actor, "admin", async (db, access) => {
    const before = await getFeaturesInTx(db, access.workspaceId);
    if (before.pembayaran && !next.pembayaran) {
      const dp = await db.select({ title: schema.meetingTypes.title }).from(schema.meetingTypes).where(sql`${schema.meetingTypes.active} AND ${schema.meetingTypes.depositIdr} > 0`).limit(3);
      if (dp.length > 0) throw new AppError("invalid_input", `Tidak bisa mematikan pembayaran: layanan aktif masih memakai DP (${dp.map((d) => d.title).join(", ")}). Nonaktifkan layanan itu dulu.`);
      const open = await db.select({ id: schema.payments.id }).from(schema.payments).where(inArray(schema.payments.status, ["pending", "awaiting_verification"])).limit(1);
      const dpProducts = await db.select({ name: schema.rentalProducts.name }).from(schema.rentalProducts).where(sql`${schema.rentalProducts.active} AND ${schema.rentalProducts.dpPercent} > 0`).limit(3);
      if (dpProducts.length > 0) throw new AppError("invalid_input", `Tidak bisa mematikan pembayaran: produk sewa masih memakai DP (${dpProducts.map((d) => d.name).join(", ")}). Ubah DP produk itu menjadi 0 dulu di menu Produk sewa.`);
      if (open.length > 0) throw new AppError("invalid_input", "Tidak bisa mematikan pembayaran: masih ada pembayaran yang menunggu pelanggan atau verifikasi Anda. Selesaikan dulu.");
    }
    if (!next.jadwal && !next.sewa) throw new AppError("invalid_input", "Aktifkan minimal satu: “Janji temu per jam” atau “Katalog produk & sewa barang”. Halaman Anda butuh salah satunya agar pelanggan bisa memesan.");
    if (before.jadwal && !next.jadwal) {
      const upcoming = await db.select({ id: schema.bookings.id }).from(schema.bookings).where(sql`${schema.bookings.status} IN ('pending', 'confirmed') AND ${schema.bookings.startsAt} > now()`).limit(1);
      if (upcoming.length > 0) throw new AppError("invalid_input", "Tidak bisa mematikan janji temu: masih ada booking mendatang yang menunggu atau terkonfirmasi. Selesaikan atau batalkan dulu di menu Tiket / Jadwal.");
    }
    if (before.sewa && !next.sewa) {
      const held = await db.select({ id: schema.reservations.id }).from(schema.reservations).where(inArray(schema.reservations.status, ["pending", "confirmed", "active"])).limit(1);
      if (held.length > 0) throw new AppError("invalid_input", "Tidak bisa mematikan katalog sewa: masih ada pesanan sewa yang menunggu, dikonfirmasi, atau sedang berjalan. Selesaikan atau batalkan dulu di menu Pesanan sewa.");
    }
    await db.update(schema.workspaces).set({ features: next }).where(eq(schema.workspaces.id, access.workspaceId));
    await audit(db, { workspaceId: access.workspaceId, actorUserId: actor.userId, action: "workspace.features_updated", entityType: "workspace", entityId: access.workspaceId, diff: { before, after: next } });
    return next;
  });
}
