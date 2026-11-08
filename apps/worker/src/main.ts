import { loadBackupEnv, loadEnv, loadMailEnv, loadPaymentEnv, loadStorageEnv } from "@jadwalin/config";
import { ConsoleEmailSender, bookingPaymentHooks, createPaymentProvider, flushObservability, initObservability, reportError, S3Storage, SmtpEmailSender, type EmailSender } from "@jadwalin/core";
import { createPool } from "@jadwalin/db";
import { pino } from "pino";
import { startWorker } from "./worker";

const log = pino({ name: "jadwalin-worker", level: process.env.LOG_LEVEL ?? "info" });

if (initObservability({ dsn: process.env.SENTRY_DSN, environment: process.env.SENTRY_ENVIRONMENT, release: process.env.SENTRY_RELEASE, service: "worker" })) log.info("pelaporan galat (Sentry) aktif");
process.on("unhandledRejection", (reason) => {
  log.error({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandledRejection");
  reportError(reason, { where: "unhandledRejection" });
});
process.on("uncaughtException", (error) => {
  log.error({ err: error.message }, "uncaughtException");
  reportError(error, { where: "uncaughtException" });
  void flushObservability().finally(() => process.exit(1));
});

const env = loadEnv();
const mail = loadMailEnv();
const pool = createPool(env.DATABASE_URL);

let sender: EmailSender;
if (mail.SMTP_URL) {
  sender = new SmtpEmailSender(mail.SMTP_URL);
} else {
  log.warn("SMTP_URL kosong: email hanya dicetak ke log (khusus pengembangan)");
  sender = new ConsoleEmailSender((line) => log.info(line));
}

let storage: S3Storage | undefined;
try {
  const s = loadStorageEnv();
  storage = new S3Storage({ endpoint: s.S3_ENDPOINT, region: s.S3_REGION, bucket: s.S3_BUCKET, accessKeyId: s.S3_ACCESS_KEY_ID, secretAccessKey: s.S3_SECRET_ACCESS_KEY, forcePathStyle: s.S3_FORCE_PATH_STYLE === "true" });
} catch {
  log.warn("penyimpanan belum dikonfigurasi; pembersihan berkas dinonaktifkan");
}

const backupEnv = loadBackupEnv();
if (!backupEnv) log.warn("BACKUP_ENABLED bukan true: backup harian dan uji restore TIDAK berjalan");
const paymentEnv = loadPaymentEnv();
function appUrl(): string {
  const u = process.env.BETTER_AUTH_URL; // URL publik aplikasi web (dipakai tautan di email pembayaran)
  if (!u) throw new Error("BETTER_AUTH_URL wajib diisi di worker saat pembayaran aktif.");
  return u;
}
if (!paymentEnv) log.warn("PAYMENT_PROVIDER kosong: rekonsiliasi pembayaran tidak berjalan");
// Hook tiket (onCancelled) dipasang di web; worker hanya melepas slot dan membatalkan pengingat (modul tiket tak diimpor di sini).
const payments = paymentEnv ? { pool, provider: createPaymentProvider(paymentEnv), hooks: bookingPaymentHooks({ baseUrl: appUrl() }) } : null;
const running = await startWorker({ redisUrl: env.REDIS_URL, deps: { pool, sender, from: mail.EMAIL_FROM, storage, log, backup: backupEnv ? { env: backupEnv, databaseUrl: env.DATABASE_URL } : null, payments } });
log.info("worker berjalan");

async function shutdown(signal: string) {
  log.info({ signal }, "mematikan worker");
  await running.close();
  await flushObservability();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
