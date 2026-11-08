/**
 * Batas fitur per workspace (aturan #12). Tabel paket/langganan baru datang di M7; sampai itu
 * semua workspace memakai batas bawaan. Modul HARUS membaca batas lewat fungsi ini, bukan hard-code.
 */
export interface Limits {
  maxFileMb: number;
  emailPerMonth: number;
  /** Fee platform per transaksi dalam basis poin (100 = 1%). Satu-satunya pendapatan dari pembayaran; dana klien tidak ditampung. */
  platformFeeBps: number;
  allowedMimeTypes: readonly string[];
}

// Tidak ada HTML/SVG/skrip/eksekusi: berkas pengguna tidak boleh dirender sebagai halaman.
export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export const DEFAULT_LIMITS: Limits = {
  maxFileMb: 10,
  emailPerMonth: 1000,
  platformFeeBps: 0, // harga belum ditetapkan pemilik; diisi dari paket (M7 entitlements)
  allowedMimeTypes: ALLOWED_MIME_TYPES,
};

export async function getLimits(_workspaceId: string): Promise<Limits> {
  return DEFAULT_LIMITS;
}
