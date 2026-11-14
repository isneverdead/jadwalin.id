import { describe, expect, it } from "vitest";
import { loadBackupEnv, loadMailEnv, loadPaymentEnv, loadProxyTrust, loadTurnstileEnv } from "./index";

describe("konfigurasi aman-secara-default", () => {
  it("kepercayaan proxy: produksi → cloudflare, selain itu none, dan bisa diganti eksplisit", () => {
    expect(loadProxyTrust({ NODE_ENV: "production" })).toBe("cloudflare");
    expect(loadProxyTrust({ NODE_ENV: "development" })).toBe("none");
    expect(loadProxyTrust({})).toBe("none");
    expect(loadProxyTrust({ NODE_ENV: "production", TRUST_PROXY: "none" })).toBe("none");
    expect(() => loadProxyTrust({ TRUST_PROXY: "apa-saja" })).toThrow();
  });

  it("Turnstile wajib di produksi dan kunci harus berpasangan", () => {
    expect(() => loadTurnstileEnv({ NODE_ENV: "production" })).toThrow(/wajib di produksi/);
    expect(() => loadTurnstileEnv({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: "s" })).toThrow();
    expect(() => loadTurnstileEnv({ TURNSTILE_SECRET_KEY: "s" })).toThrow(/bersamaan/);
    expect(loadTurnstileEnv({})).toEqual({ secret: null, siteKey: null });
    expect(loadTurnstileEnv({ NODE_ENV: "production", TURNSTILE_SECRET_KEY: "s", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "k" })).toEqual({ secret: "s", siteKey: "k" });
  });

  it("SMTP wajib di produksi", () => {
    expect(() => loadMailEnv({ NODE_ENV: "production" })).toThrow(/SMTP_URL wajib/);
    expect(loadMailEnv({}).SMTP_URL).toBeUndefined();
  });

  it("backup: mati secara default; bila hidup semua nilai wajib dan frasa sandi minimal 32 karakter", () => {
    expect(loadBackupEnv({})).toBeNull();
    expect(() => loadBackupEnv({ BACKUP_ENABLED: "true" })).toThrow(/wajib diisi/);
    expect(() => loadBackupEnv({ BACKUP_ENABLED: "true", BACKUP_S3_BUCKET: "bk", BACKUP_S3_ACCESS_KEY_ID: "a", BACKUP_S3_SECRET_ACCESS_KEY: "b", BACKUP_PASSPHRASE: "pendek" })).toThrow(/BACKUP_PASSPHRASE/);
    const ok = loadBackupEnv({ BACKUP_ENABLED: "true", BACKUP_S3_BUCKET: "bk-jadwalin", BACKUP_S3_ACCESS_KEY_ID: "a", BACKUP_S3_SECRET_ACCESS_KEY: "b", BACKUP_PASSPHRASE: "x".repeat(32) });
    expect(ok?.s3.bucket).toBe("bk-jadwalin");
  });
});

describe("loadPaymentEnv", () => {
  it("kosong = pembayaran manual (bawaan, ADR 0002)", () => {
    expect(loadPaymentEnv({})).toEqual({ provider: "manual" });
    expect(loadPaymentEnv({ PAYMENT_PROVIDER: "manual" })).toEqual({ provider: "manual" });
  });
  it("fake butuh rahasia dan DILARANG di produksi", () => {
    expect(loadPaymentEnv({ PAYMENT_PROVIDER: "fake", PAYMENT_FAKE_SECRET: "x".repeat(16) })).toEqual({ provider: "fake", fakeSecret: "x".repeat(16) });
    expect(() => loadPaymentEnv({ PAYMENT_PROVIDER: "fake" })).toThrow(/PAYMENT_FAKE_SECRET|tidak valid/);
    expect(() => loadPaymentEnv({ PAYMENT_PROVIDER: "fake", PAYMENT_FAKE_SECRET: "x".repeat(16), NODE_ENV: "production" })).toThrow(/produksi/);
  });
  it("midtrans: kunci wajib dan harus cocok dengan lingkungan (sandbox vs produksi)", () => {
    expect(() => loadPaymentEnv({ PAYMENT_PROVIDER: "midtrans" })).toThrow(/MIDTRANS_SERVER_KEY/);
    expect(loadPaymentEnv({ PAYMENT_PROVIDER: "midtrans", MIDTRANS_SERVER_KEY: "SB-Mid-server-abcdef", MIDTRANS_ENV: "sandbox" })).toMatchObject({ provider: "midtrans", environment: "sandbox" });
    expect(() => loadPaymentEnv({ PAYMENT_PROVIDER: "midtrans", MIDTRANS_SERVER_KEY: "SB-Mid-server-abcdef", MIDTRANS_ENV: "production" })).toThrow(/tidak cocok/);
    expect(() => loadPaymentEnv({ PAYMENT_PROVIDER: "midtrans", MIDTRANS_SERVER_KEY: "Mid-server-abcdef123", MIDTRANS_ENV: "sandbox" })).toThrow(/tidak cocok/);
  });
});
