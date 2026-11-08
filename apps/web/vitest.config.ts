import { defineConfig } from "vitest/config";

// Berkas e2e/ dijalankan Playwright (`pnpm e2e`), bukan vitest.
export default defineConfig({ test: { exclude: ["e2e/**", "node_modules/**", ".next/**"] } });
