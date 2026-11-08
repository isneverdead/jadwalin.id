import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

const webEnvSchema = envSchema.extend({
  BETTER_AUTH_SECRET: z.string().min(32, "minimal 32 karakter"),
  BETTER_AUTH_URL: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;

export function loadWebEnv(source: Record<string, string | undefined> = process.env): WebEnv {
  const parsed = webEnvSchema.safeParse(source);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Konfigurasi env tidak valid: ${keys}`);
  }
  return parsed.data;
}

/** Validasi env saat start; gagal cepat dengan pesan jelas, tanpa mencetak nilai secret. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Konfigurasi env tidak valid: ${keys}`);
  }
  return parsed.data;
}

const storageEnvSchema = z.object({
  S3_ENDPOINT: z.string().url().optional(), // kosong = AWS; R2: https://<account>.r2.cloudflarestorage.com
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
});
export type StorageEnv = z.infer<typeof storageEnvSchema>;

export function loadStorageEnv(source: Record<string, string | undefined> = process.env): StorageEnv {
  const parsed = storageEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Konfigurasi penyimpanan tidak valid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}

const mailEnvSchema = z.object({
  EMAIL_FROM: z.string().min(3).default("jadwalin <noreply@jadwalin.id>"),
  /** smtp://user:pass@host:587. Kosong hanya diizinkan di luar produksi (email dicetak ke log). */
  SMTP_URL: z.string().url().optional(),
  NODE_ENV: z.string().optional(),
});
export type MailEnv = z.infer<typeof mailEnvSchema>;

export function loadMailEnv(source: Record<string, string | undefined> = process.env): MailEnv {
  const parsed = mailEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Konfigurasi email tidak valid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.SMTP_URL) {
    throw new Error("Konfigurasi email tidak valid: SMTP_URL wajib di produksi");
  }
  return parsed.data;
}

const turnstileSchema = z.object({
  /** Kunci rahasia Cloudflare Turnstile (server). */
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  /** Kunci situs (publik, tampil di halaman). */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  NODE_ENV: z.string().optional(),
});
export type TurnstileEnv = { secret: string | null; siteKey: string | null };

/**
 * Di produksi KEDUA kunci wajib ada (halaman publik tanpa perlindungan bot tidak boleh berjalan). Di luar produksi,
 * tanpa kunci verifikasi dilewati supaya pengembangan lokal tetap mudah. Kunci uji Cloudflare ada di .env.example.
 */
export function loadTurnstileEnv(source: Record<string, string | undefined> = process.env): TurnstileEnv {
  const parsed = turnstileSchema.parse(source);
  const secret = parsed.TURNSTILE_SECRET_KEY ?? null;
  const siteKey = parsed.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null;
  if (parsed.NODE_ENV === "production" && (!secret || !siteKey)) {
    throw new Error("Konfigurasi Turnstile tidak valid: TURNSTILE_SECRET_KEY dan NEXT_PUBLIC_TURNSTILE_SITE_KEY wajib di produksi");
  }
  if (Boolean(secret) !== Boolean(siteKey)) {
    throw new Error("Konfigurasi Turnstile tidak valid: kunci situs dan kunci rahasia harus diisi bersamaan");
  }
  return { secret, siteKey };
}

const proxySchema = z.object({
  /** cloudflare = percaya HANYA header cf-connecting-ip (origin wajib dikunci agar hanya Cloudflare yang bisa menjangkaunya); none = dev. */
  TRUST_PROXY: z.enum(["cloudflare", "none"]).optional(),
  NODE_ENV: z.string().optional(),
});
export type ProxyTrust = "cloudflare" | "none";

export function loadProxyTrust(source: Record<string, string | undefined> = process.env): ProxyTrust {
  const parsed = proxySchema.parse(source);
  return parsed.TRUST_PROXY ?? (parsed.NODE_ENV === "production" ? "cloudflare" : "none");
}

const backupSchema = z.object({
  BACKUP_ENABLED: z.enum(["true", "false"]).default("false"),
  BACKUP_S3_ENDPOINT: z.string().url().optional(),
  BACKUP_S3_REGION: z.string().default("auto"),
  BACKUP_S3_BUCKET: z.string().min(3).optional(),
  BACKUP_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  BACKUP_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  /** Frasa sandi enkripsi backup (>= 32 karakter). SIMPAN TERPISAH dari backup: kehilangannya = backup tak bisa dibuka. */
  BACKUP_PASSPHRASE: z.string().min(32).optional(),
  /** Server tempat uji restore dijalankan (butuh hak CREATE DATABASE); default DATABASE_URL. */
  BACKUP_VERIFY_DATABASE_URL: z.string().url().optional(),
  /** Direktori klien pg_dump/pg_restore yang SEMAJOR dengan server. */
  PG_BIN_DIR: z.string().optional(),
});
export type BackupEnv = {
  s3: { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
  passphrase: string;
  verifyDatabaseUrl?: string;
  pgBinDir?: string;
};

/** null = backup dimatikan. Bila BACKUP_ENABLED=true semua nilai wajib ada (gagal cepat saat start). */
export function loadBackupEnv(source: Record<string, string | undefined> = process.env): BackupEnv | null {
  const parsed = backupSchema.safeParse(source);
  if (!parsed.success) throw new Error(`Konfigurasi backup tidak valid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  const e = parsed.data;
  if (e.BACKUP_ENABLED !== "true") return null;
  const missing = (["BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_PASSPHRASE"] as const).filter((k) => !e[k]);
  if (missing.length) throw new Error(`Konfigurasi backup tidak valid: wajib diisi: ${missing.join(", ")}`);
  return {
    s3: { endpoint: e.BACKUP_S3_ENDPOINT, region: e.BACKUP_S3_REGION, bucket: e.BACKUP_S3_BUCKET!, accessKeyId: e.BACKUP_S3_ACCESS_KEY_ID!, secretAccessKey: e.BACKUP_S3_SECRET_ACCESS_KEY!, forcePathStyle: e.BACKUP_S3_FORCE_PATH_STYLE === "true" },
    passphrase: e.BACKUP_PASSPHRASE!,
    verifyDatabaseUrl: e.BACKUP_VERIFY_DATABASE_URL,
    pgBinDir: e.PG_BIN_DIR,
  };
}

// --- Pembayaran (ADR 0001) ---------------------------------------------------------------------------

const paymentSchema = z.object({
  PAYMENT_PROVIDER: z.enum(["fake", "midtrans"]).optional(),
  PAYMENT_FAKE_SECRET: z.string().min(16).optional(),
  MIDTRANS_SERVER_KEY: z.string().min(10).optional(),
  MIDTRANS_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  NODE_ENV: z.string().optional(),
});
export type PaymentEnv = { provider: "fake"; fakeSecret: string } | { provider: "midtrans"; serverKey: string; environment: "sandbox" | "production" };

/** null = pembayaran dimatikan (jenis pertemuan berDP ditolak, gagal tertutup). Penyedia 'fake' dilarang di produksi. */
export function loadPaymentEnv(source: Record<string, string | undefined> = process.env): PaymentEnv | null {
  const parsed = paymentSchema.safeParse(source);
  if (!parsed.success) throw new Error(`Konfigurasi pembayaran tidak valid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  const e = parsed.data;
  if (!e.PAYMENT_PROVIDER) return null;
  if (e.PAYMENT_PROVIDER === "fake") {
    if (e.NODE_ENV === "production" && source.ALLOW_FAKE_PAYMENTS !== "true") throw new Error("Konfigurasi pembayaran tidak valid: penyedia 'fake' tidak boleh dipakai di produksi.");
    if (!e.PAYMENT_FAKE_SECRET) throw new Error("Konfigurasi pembayaran tidak valid: wajib diisi: PAYMENT_FAKE_SECRET");
    return { provider: "fake", fakeSecret: e.PAYMENT_FAKE_SECRET };
  }
  if (!e.MIDTRANS_SERVER_KEY) throw new Error("Konfigurasi pembayaran tidak valid: wajib diisi: MIDTRANS_SERVER_KEY");
  // Kunci sandbox ("SB-") tidak boleh dipakai di lingkungan produksi dan sebaliknya.
  const sandboxKey = e.MIDTRANS_SERVER_KEY.startsWith("SB-");
  if ((e.MIDTRANS_ENV === "production") === sandboxKey) throw new Error("Konfigurasi pembayaran tidak valid: MIDTRANS_SERVER_KEY tidak cocok dengan MIDTRANS_ENV.");
  return { provider: "midtrans", serverKey: e.MIDTRANS_SERVER_KEY, environment: e.MIDTRANS_ENV };
}
