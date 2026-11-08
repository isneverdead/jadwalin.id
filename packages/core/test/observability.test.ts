import { describe, expect, it } from "vitest";
import { flushObservability, initObservability, reportError, scrubString } from "../src";

describe("scrubString: tidak ada data pribadi/rahasia yang lolos", () => {
  it.each([
    ["Gagal untuk budi.santoso@gmail.com", "Gagal untuk [email]"],
    ["telepon 081234567890 gagal", "telepon [telepon] gagal"],
    ["tel +6281234567890.", "tel [telepon]."],
    ["GET /booking/AbCdEf123456_-GhIjKlMnOp12 404", "GET /booking/[token] 404"],
    ["/undangan/mUIYeT6GfblPn9V0Y_hll02EEYKthwOswaySw82g5KI", "/undangan/[token]"],
    ["/api/auth/reset-password/kaifKtAqJ4BZQpfgBilIiQN6?callbackURL=x", "/api/auth/reset-password/[token]?callbackURL=x"],
    ["verify?token=eyJhbGciOiJIUzI1NiJ9.abc&callbackURL=/", "verify?token=[token]&callbackURL=/"],
    ["hash 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f", "hash [token]"],
  ])("%s", (input, expected) => {
    expect(scrubString(input)).toBe(expected);
  });

  it("galat Drizzle/pg: parameter terikat (email, token, hash) DIBUANG", () => {
    const msg = `Failed query: insert into "users" ("email", "name") values ($1, $2)\nparams: korban@gmail.com,Budi Santoso`;
    const out = scrubString(msg);
    expect(out).toContain("Failed query: insert into");
    expect(out).not.toContain("korban");
    expect(out).not.toContain("Budi");
    expect(out).toContain("params: [dibuang]");
  });

  it("potongan kode sumber di tumpukan tidak ikut terkirim, tetapi berkas dan nomor baris tetap", async () => {
    const sent: unknown[] = [];
    const transport = () => ({ send: async (env: unknown) => (sent.push(env), {}), flush: async () => true });
    initObservability({ dsn: "https://publickey@o0.ingest.sentry.io/1", service: "web", transport });
    reportError(new Error("rahasia-literal-di-sumber-ini-1234567890abcdef"), { where: "uji-konteks" });
    await flushObservability(3000);
    const text = JSON.stringify(sent);
    expect(text).not.toContain("context_line");
    expect(text).not.toContain("pre_context");
    expect(text).toContain("lineno");
  });

  it("teks biasa tidak rusak", () => {
    expect(scrubString("Jadwal itu sudah tidak tersedia.")).toBe("Jadwal itu sudah tidak tersedia.");
    expect(scrubString("tiket #12 ditutup")).toBe("tiket #12 ditutup");
  });
});

describe("initObservability (transport tiruan)", () => {
  it("tanpa DSN: mati dan reportError tidak melakukan apa pun", () => {
    expect(initObservability({ dsn: undefined, service: "web" })).toBe(false);
    expect(() => reportError(new Error("x"), { where: "uji" })).not.toThrow();
  });

  it("galat yang dilaporkan sudah bersih: URL bertoken, email, parameter SQL, cookie, dan isi permintaan tidak keluar", async () => {
    const sent: unknown[] = [];
    const transport = () => ({ send: async (env: unknown) => (sent.push(env), {}), flush: async () => true });
    expect(initObservability({ dsn: "https://publickey@o0.ingest.sentry.io/1", service: "worker", transport })).toBe(true);

    const err = new Error(`Failed query: select * from bookings where cancel_token_hash = $1\nparams: abcdefghijklmnopqrstuvwxyz0123456789ABCD, tamu@kantor.co.id (kontak 081234567890) di /booking/AbCdEf123456_-GhIjKlMnOp12`);
    reportError(err, { where: "uji-pelaporan", job: "dispatch-email" });
    await flushObservability(3000);

    const payload = JSON.stringify(sent);
    expect(payload).toContain("uji-pelaporan");
    expect(payload).toContain("Failed query"); // informasi yang berguna tetap ada
    for (const secret of ["abcdefghijklmnopqrstuvwxyz0123456789ABCD", "tamu@kantor.co.id", "081234567890", "AbCdEf123456_-GhIjKlMnOp12"]) {
      expect(payload, `bocor: ${secret}`).not.toContain(secret);
    }
  });
});
