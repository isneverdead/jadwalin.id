import path from "node:path";
import type { NextConfig } from "next";

// E2E membangun ke folder terpisah (NEXT_DIST_DIR) supaya tidak merusak server dev yang sedang memakai .next.
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: ["@jadwalin/core", "@jadwalin/db", "@jadwalin/config", "@jadwalin/module-tickets", "@jadwalin/module-rental"],
  // Sentry/OpenTelemetry memakai require dinamis dan modul Node: jangan dibundel webpack.
  serverExternalPackages: ["pg", "@sentry/node", "@sentry/core", "@opentelemetry/instrumentation", "require-in-the-middle", "import-in-the-middle"],
  poweredByHeader: false,
  // Uji dari HP lewat tunnel Cloudflare (hanya berlaku di `next dev`).
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Rilis ke server kecil: BUILD_STANDALONE=1 menghasilkan server mandiri (tanpa pnpm install di server).
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const, outputFileTracingRoot: path.join(__dirname, "../..") } : {}),
};

export default config;
