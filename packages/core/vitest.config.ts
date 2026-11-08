import { defineConfig } from "vitest/config";

// Tes DB berbagi satu database dan dispatcher outbox bersifat lintas-workspace: jalankan berkas berurutan.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000 } });
