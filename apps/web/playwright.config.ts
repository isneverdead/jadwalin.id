import { defineConfig } from "@playwright/test";

const PORT = 3100;

/**
 * E2E memakai build produksi di port 3100 (3000 tetap untuk dev). Butuh Postgres, S3 (CORS untuk
 * origin ini; lihat `ensure-bucket`) dan variabel DATABASE_URL, S3_*. Worker TIDAK boleh berjalan
 * (ia menghapus payload email setelah terkirim, padahal tes membaca tautan dari outbox).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${PORT}`, // NEXT_DIST_DIR (env di bawah) memisahkan hasil build dari server dev
    url: `http://localhost:${PORT}/masuk`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...(process.env as Record<string, string>),
      // E2E berjalan tanpa Cloudflare di depan: tanpa ini produksi menolak pemesanan karena tak ada cf-connecting-ip.
      NEXT_DIST_DIR: ".next-e2e",
      TRUST_PROXY: "none",
      BETTER_AUTH_URL: `http://localhost:${PORT}`,
      BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      // Kunci UJI Cloudflare Turnstile (selalu lolos): widget dan verifikasi server benar-benar dipanggil.
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    },
  },
});
