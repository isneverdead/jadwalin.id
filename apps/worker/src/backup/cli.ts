import { loadBackupEnv, loadEnv } from "@jadwalin/config";
import { createPool } from "@jadwalin/db";
import { pruneBackupsJob, runBackupJob, verifyBackupJob } from "./jobs";
import { BACKUP_PREFIX } from "./backup";
import { listManifests } from "./restore";
import { BackupStore } from "./store";

/**
 * Pemakaian: pnpm --filter @jadwalin/worker backup <backup|verify|prune|list>
 *   backup  buat backup terenkripsi sekarang
 *   verify  pulihkan backup terbaru ke database sementara dan verifikasi (uji restore)
 *   prune   terapkan retensi (7 harian, 4 mingguan, 6 bulanan)
 *   list    daftar backup
 */
const cmd = process.argv[2];
const env = loadBackupEnv();
if (!env) {
  console.error("BACKUP_ENABLED bukan true. Isi variabel BACKUP_* (lihat .env.example).");
  process.exit(2);
}
const databaseUrl = loadEnv().DATABASE_URL;
const pool = createPool(databaseUrl);
const ctx = { pool, databaseUrl, env };

try {
  if (cmd === "backup") console.log(await runBackupJob(ctx));
  else if (cmd === "verify") console.log(await verifyBackupJob(ctx));
  else if (cmd === "prune") console.log(await pruneBackupsJob(ctx));
  else if (cmd === "list") {
    const store = new BackupStore({ endpoint: env.s3.endpoint, region: env.s3.region, bucket: env.s3.bucket, accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey, forcePathStyle: env.s3.forcePathStyle });
    for (const m of await listManifests(store, BACKUP_PREFIX)) console.log(`${m.createdAt}  ${(m.sizeBytes / 1024 / 1024).toFixed(1)} MB  ${m.key}`);
  } else {
    console.error("Perintah tidak dikenal. Gunakan: backup | verify | prune | list");
    process.exitCode = 2;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
