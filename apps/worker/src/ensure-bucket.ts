import { loadStorageEnv } from "@jadwalin/config";
import { S3Storage } from "@jadwalin/core";

/**
 * Dev/CI: buat bucket dan pasang CORS agar browser boleh PUT langsung ke URL ber-tanda-tangan.
 * Produksi (R2): atur CORS bucket di dashboard Cloudflare dengan aturan yang sama; jangan jalankan ini ke produksi.
 *   APP_ORIGINS=http://localhost:3000,http://localhost:3100 pnpm --filter @jadwalin/worker ensure-bucket   (3100 = E2E)
 */
const s = loadStorageEnv();
const storage = new S3Storage({ endpoint: s.S3_ENDPOINT, region: s.S3_REGION, bucket: s.S3_BUCKET, accessKeyId: s.S3_ACCESS_KEY_ID, secretAccessKey: s.S3_SECRET_ACCESS_KEY, forcePathStyle: s.S3_FORCE_PATH_STYLE === "true" });
await storage.ensureBucket((process.env.APP_ORIGINS ?? "http://localhost:3000,http://localhost:3100").split(",").map((o) => o.trim()));
console.log(`Bucket "${s.S3_BUCKET}" siap.`);
