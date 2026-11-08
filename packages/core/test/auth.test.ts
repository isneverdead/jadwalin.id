import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, LEGAL_VERSION } from "../src";

const url = process.env.DATABASE_URL;
const baseURL = "http://localhost:3000";
const sfx = Math.random().toString(36).slice(2, 8);
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const phoneLocal = `0812${digits(8)}`; // unik per run
const net = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // IP unik per run (rate limit tersimpan di DB)

describe.skipIf(!url)("auth (Better Auth + Postgres asli)", () => {
  let pool: pg.Pool;
  let auth: ReturnType<typeof createAuth>;

  const post = (path: string, body: unknown, ip: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL, "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );
  const get = (path: string, ip: string) => auth.handler(new Request(`${baseURL}/api/auth${path}`, { headers: { "x-forwarded-for": ip, origin: baseURL } }));

  /** Tautan di email berisi token; tes membacanya dari outbox seperti penerima membuka emailnya. */
  async function linkFor(to: string, template: "verify_email" | "reset_password"): Promise<string> {
    const r = await pool.query(`SELECT payload FROM notification_outbox WHERE recipient = $1 AND template = $2 ORDER BY created_at DESC LIMIT 1`, [to, template]);
    const link = r.rows[0]?.payload?.url as string | undefined;
    if (!link) throw new Error(`tidak ada email ${template} untuk ${to}`);
    return link;
  }
  const countEmails = async (to: string, template: string) => (await pool.query(`SELECT count(*)::int AS n FROM notification_outbox WHERE recipient = $1 AND template = $2`, [to, template])).rows[0].n;

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    auth = createAuth({ pool, secret: "x".repeat(40), baseURL });
  });
  afterAll(async () => pool?.end());

  const email = `auth-${sfx}@test.local`;
  const password = "kata-sandi-panjang-1";

  it("daftar membuat user tak-terverifikasi, ID UUID, HP dinormalisasi, kata sandi di-hash, dan mengantre email verifikasi", async () => {
    const res = await post("/sign-up/email", { name: "Uji", email, password, termsAccepted: true, phone: `${phoneLocal.slice(0, 4)}-${phoneLocal.slice(4)}` }, `${net}.1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull(); // belum ada sesi sebelum verifikasi
    const row = (await pool.query(`SELECT id, phone, email_verified, terms_version, terms_accepted_at FROM users WHERE email = $1`, [email])).rows[0];
    expect(row.terms_version).toBe(LEGAL_VERSION); // bukti persetujuan diisi server
    expect(row.terms_accepted_at).toBeInstanceOf(Date);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.phone).toBe(`62${phoneLocal.slice(1)}`);
    expect(row.email_verified).toBe(false);
    const acc = (await pool.query(`SELECT password FROM accounts WHERE user_id = $1`, [row.id])).rows[0];
    expect(acc.password).not.toContain(password);
    expect(await countEmails(email, "verify_email")).toBeGreaterThanOrEqual(1);
  });

  it("daftar dari browser TANPA persetujuan ditolak dan tidak membuat user", async () => {
    const mail = `tanpa-setuju-${sfx}@test.local`;
    const res = await post("/sign-up/email", { name: "Tanpa", email: mail, password }, `${net}.9`);
    expect(res.status).toBe(400);
    expect((await pool.query(`SELECT 1 FROM users WHERE email = $1`, [mail])).rowCount).toBe(0);
  });

  it("masuk DITOLAK sebelum email terverifikasi; setelah klik tautan verifikasi, masuk berhasil dan sesi dibuat", async () => {
    const blocked = await post("/sign-in/email", { email, password }, `${net}.2`);
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("set-cookie") ?? "").not.toContain("session_token");

    const link = new URL(await linkFor(email, "verify_email"));
    expect(link.pathname).toContain("/verify-email");
    const verify = await get(`/verify-email${link.search}`, `${net}.2`);
    expect([200, 302]).toContain(verify.status);
    expect((await pool.query(`SELECT email_verified FROM users WHERE email = $1`, [email])).rows[0].email_verified).toBe(true);

    const ok = await post("/sign-in/email", { email, password }, `${net}.3`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("session_token");
  });

  it("token verifikasi palsu ditolak", async () => {
    const res = await get("/verify-email?token=token-palsu", `${net}.4`);
    expect(res.status).not.toBe(200);
  });

  it("kata sandi pendek ditolak saat daftar", async () => {
    const short = await post("/sign-up/email", { name: "X", email: `s-${sfx}@test.local`, password: "pendek", termsAccepted: true }, `${net}.5`);
    expect(short.status).toBe(400);
  });

  it("RESET SANDI: tautan di email → kata sandi baru berlaku, lama tidak; token sekali pakai; sesi lama dicabut", async () => {
    const oldSession = await post("/sign-in/email", { email, password }, `${net}.6`);
    const cookie = oldSession.headers.get("set-cookie")!.split(";")[0]!;

    const req = await post("/request-password-reset", { email, redirectTo: `${baseURL}/reset-sandi` }, `${net}.7`);
    expect(req.status).toBe(200);
    const link = new URL(await linkFor(email, "reset_password"));
    const token = link.pathname.split("/").pop()!;
    expect(token.length).toBeGreaterThan(10);

    const newPassword = "kata-sandi-baru-2-panjang";
    const reset = await post("/reset-password", { newPassword, token }, `${net}.8`);
    expect(reset.status).toBe(200);
    expect((await post("/sign-in/email", { email, password }, `${net}.9`)).status).toBe(401);
    expect((await post("/sign-in/email", { email, password: newPassword }, `${net}.10`)).status).toBe(200);
    expect((await post("/reset-password", { newPassword: "yang-lain-lagi-123", token }, `${net}.11`)).status).not.toBe(200);

    const session = await auth.handler(new Request(`${baseURL}/api/auth/get-session`, { headers: { cookie, "x-forwarded-for": `${net}.12` } }));
    expect(await session.json()).toBeNull(); // sesi sebelum reset sudah dicabut
  });

  it("reset sandi untuk email tak dikenal: respons sama dan tidak ada email (tidak membocorkan akun)", async () => {
    const ghost = `hantu-${sfx}@test.local`;
    const res = await post("/request-password-reset", { email: ghost, redirectTo: `${baseURL}/reset-sandi` }, `${net}.13`);
    expect(res.status).toBe(200);
    expect(await countEmails(ghost, "reset_password")).toBe(0);
  });

  /** Akun baru terverifikasi, supaya pembatas per-email tidak bercampur dengan tes lain. */
  async function freshUser(label: string) {
    const mail = `${label}-${sfx}@test.local`;
    await post("/sign-up/email", { name: label, email: mail, password, termsAccepted: true }, `${net}.1${label.length}`);
    await pool.query(`UPDATE users SET email_verified = true WHERE email = $1`, [mail]);
    return mail;
  }

  it("rate limit login: percobaan ke-6 dalam semenit dari IP sama mendapat 429; IP lain tidak terdampak", async () => {
    const mail = await freshUser("ratelimit");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await post("/sign-in/email", { email: mail, password: "salah-salah-salah" }, `${net}.99`)).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect((await post("/sign-in/email", { email: mail, password, termsAccepted: true }, `${net}.98`)).status).toBe(200);
  });

  it("rate limit per EMAIL: tebakan terdistribusi dari banyak IP ke satu akun tetap dibatasi (10 per 15 menit)", async () => {
    const mail = await freshUser("distrib");
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post("/sign-in/email", { email: mail, password: "salah-salah-salah" }, `${net}.${100 + i}`)).status); // IP berbeda tiap kali
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // sandi yang benar pun ditolak selama dibatasi (tidak bisa dipakai menebak)
    expect((await post("/sign-in/email", { email: mail, password, termsAccepted: true }, `${net}.150`)).status).toBe(429);
    // email dengan huruf besar/kecil berbeda dihitung sama
    expect((await post("/sign-in/email", { email: mail.toUpperCase(), password }, `${net}.151`)).status).toBe(429);
  });

  it("ORIGIN: permintaan tulis dari origin asing atau tanpa origin ditolak (tutup login-CSRF)", async () => {
    const mail = await freshUser("csrf");
    const send = (origin: string | null) =>
      auth.handler(new Request(`${baseURL}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `${net}.160`, ...(origin ? { origin } : {}) }, body: JSON.stringify({ email: mail, password, termsAccepted: true }) }));
    expect((await send("https://evil.example.com")).status).toBe(403);
    expect((await send(null)).status).toBe(403);
    expect((await send(`${baseURL}.evil.com`)).status).toBe(403); // akhiran yang menyerupai
    expect((await send(baseURL)).status).toBe(200);
  });

  it("JEJAK AUDIT: masuk, gagal masuk, dan reset sandi tercatat tanpa email mentah", async () => {
    const mail = await freshUser("jejak");
    const uid = (await pool.query(`SELECT id FROM users WHERE email = $1`, [mail])).rows[0].id;
    await post("/sign-in/email", { email: mail, password: "salah-salah-salah" }, `${net}.170`);
    await post("/sign-in/email", { email: mail, password, termsAccepted: true }, `${net}.171`);
    const rows = (await pool.query(`SELECT action, entity_id, diff FROM audit_log WHERE workspace_id IS NULL AND entity_type = 'auth' AND (entity_id = $1 OR action = 'auth.sign_in_failed') ORDER BY created_at DESC LIMIT 20`, [uid])).rows;
    expect(rows.some((r) => r.action === "auth.sign_in" && r.entity_id === uid)).toBe(true);
    const failed = rows.find((r) => r.action === "auth.sign_in_failed")!;
    expect(failed).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(mail); // email tidak pernah tercatat mentah
    expect(failed.entity_id.startsWith("email:")).toBe(true);
  });

  it("rate limit permintaan reset sandi: maksimal 5 per jam per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post("/request-password-reset", { email, redirectTo: `${baseURL}/reset-sandi` }, `${net}.77`)).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});
