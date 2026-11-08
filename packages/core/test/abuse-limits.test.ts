import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  bookPublic,
  computeSlots,
  createAuth,
  createMeetingType,
  createWorkspace,
  inviteMember,
  listClients,
  listInvitations,
  MAX_OWNED_WORKSPACES,
  MAX_SLOTS_PER_QUERY,
  normalizeRecipientKey,
  PUBLIC_LIMITS,
  revokeInvitation,
  setClientBlocked,
  setWeeklyAvailability,
} from "../src";

describe("normalizeRecipientKey (alias email dihitung satu penerima)", () => {
  it.each([
    ["Korban@Gmail.com", "korban@gmail.com"],
    ["korban+promo@gmail.com", "korban@gmail.com"],
    ["k.o.r.b.a.n@gmail.com", "korban@gmail.com"],
    ["korban+x@googlemail.com", "korban@gmail.com"],
    ["a.b+tag@kantor.co.id", "a.b@kantor.co.id"], // titik hanya diabaikan untuk Gmail
    ["  Budi@Domain.ID ", "budi@domain.id"],
  ])("%s → %s", (input, expected) => expect(normalizeRecipientKey(input)).toBe(expected));
});

describe("batas beban hitung slot", () => {
  it("konfigurasi ekstrem (365 hari x langkah 5 menit) berhenti di batas aman", () => {
    const slots = computeSlots({
      now: new Date("2035-03-05T00:00:00Z"), timezone: "Asia/Jakarta", durationMin: 5, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, maxDaysAhead: 365, stepMin: 5,
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "00:00", end: "23:59" })), overrides: [], busy: [],
    });
    expect(slots.length).toBe(MAX_SLOTS_PER_QUERY);
    expect(slots.at(0)!.start.getTime()).toBeLessThan(slots.at(-1)!.start.getTime()); // tetap terurut dari yang paling awal
  });
});

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);
const NOW = new Date("2035-03-05T00:00:00Z"); // Senin 07:00 WIB
const base = { baseUrl: "http://t.local", now: NOW };

describe.skipIf(!url)("pembatasan penyalahgunaan (Postgres asli)", () => {
  let pool: pg.Pool;
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));
  const mkUser = async (label: string, verified = true) => {
    const email = `${label}-${sfx}@abuse.local`;
    const r = await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, $3) RETURNING id`, [email, label, verified]);
    return { id: r.rows[0].id as string, email };
  };
  let slotN = 0;
  const slot = () => {
    const i = slotN++;
    return new Date(Date.UTC(2035, 2, 5 + 7 * (1 + Math.floor(i / 3)), 2 + (i % 3)));
  };
  let n = 0;
  const guest = (extra: Record<string, unknown> = {}) => ({ name: "Tamu Abuse", email: `g${++n}-${sfx}@abuse.local`, topic: "Konsultasi", startsAt: slot(), privacyAck: true, ...extra }) as Parameters<typeof bookPublic>[3];

  /** Workspace siap dipesan: jam rutin Senin 09–12 dan satu jenis pertemuan (pemilik = host). */
  async function bookableWorkspace(label: string, locationKind: "link" | "in_person" = "link", locationValue = "https://meet.example.com/x") {
    const owner = await mkUser(`own-${label}`);
    const slug = `ab-${label}-${sfx}`;
    await createWorkspace(pool, owner.id, { name: `Ruang ${label}`, slug });
    const actor = { userId: owner.id, slug };
    await setWeeklyAvailability(pool, actor, { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    await createMeetingType(pool, actor, { slug: "sesi", title: "Sesi", durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 90, locationKind, locationValue });
    return { owner, slug, actor };
  }

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
  });
  afterAll(async () => pool?.end());

  it("jenis pertemuan dengan kombinasi interval/rentang yang ekstrem ditolak", async () => {
    const owner = await mkUser("ekstrem");
    await createWorkspace(pool, owner.id, { name: "Ekstrem", slug: `ab-ekstrem-${sfx}` });
    const actor = { userId: owner.id, slug: `ab-ekstrem-${sfx}` };
    expect(await code(createMeetingType(pool, actor, { slug: "rapat", title: "Terlalu rapat", durationMin: 5, slotStepMin: 5, maxDaysAhead: 365, locationKind: "phone" }))).toBe("invalid_input");
    expect(await code(createMeetingType(pool, actor, { slug: "wajar", title: "Wajar", durationMin: 30, slotStepMin: 30, maxDaysAhead: 90, locationKind: "phone" }))).toBe("ok");
  });

  it("satu akun maksimal memiliki 5 workspace", async () => {
    const owner = await mkUser("banyak");
    for (let i = 0; i < MAX_OWNED_WORKSPACES; i++) await createWorkspace(pool, owner.id, { name: `Ruang ${i}`, slug: `ab-banyak${i}-${sfx}` });
    expect(await code(createWorkspace(pool, owner.id, { name: "Keenam", slug: `ab-banyak6-${sfx}` }))).toBe("invalid_input");
  });

  it("UNDANGAN: maksimal 3 per penerima per hari di seluruh platform (alias dihitung sama)", async () => {
    const a = await bookableWorkspace("inv");
    const victim = `korban-${sfx}@gmail.com`;
    const aliases = [victim, `korban-${sfx}+a@gmail.com`, `k.orban-${sfx}+b@gmail.com`.replace("k.orban", "korban")];
    for (const email of aliases) {
      await inviteMember(pool, a.actor, { email, role: "staff" }, base);
      const pending = (await listInvitations(pool, a.actor, NOW)).find((i) => i.email === email.toLowerCase())!;
      await revokeInvitation(pool, a.actor, pending.id); // dibatalkan agar bukan batas "undangan aktif ganda" yang diuji
    }
    expect(await code(inviteMember(pool, a.actor, { email: `korban-${sfx}+lagi@gmail.com`, role: "staff" }, base))).toBe("rate_limited");
    // workspace lain pun tak bisa mengirim ke penerima yang sama (batas bersifat global)
    const b = await bookableWorkspace("inv2");
    expect(await code(inviteMember(pool, b.actor, { email: victim, role: "staff" }, base))).toBe("rate_limited");
  });

  it("BOOKING: batas per penerima berlaku lintas workspace dan menembus alias email", async () => {
    const a = await bookableWorkspace("relay-a");
    const b = await bookableWorkspace("relay-b");
    const victim = `mangsa-${sfx}@gmail.com`;
    const variants = [victim, `mangsa-${sfx}+1@gmail.com`, `mangsa-${sfx}+2@gmail.com`];
    const results: string[] = [];
    for (const ws of [a, b]) for (const email of variants) results.push(await code(bookPublic(pool, ws.slug, "sesi", guest({ email }), base)));
    // batas per email-per-workspace (3) dan global (6) sama-sama terlampaui oleh alias: tepat 3 di A lolos, B kena batas global saat total > 6? 3+3=6 lolos
    expect(results.slice(0, 3)).toEqual(["ok", "ok", "ok"]);
    expect(await code(bookPublic(pool, a.slug, "sesi", guest({ email: `mangsa-${sfx}+3@gmail.com` }), base))).toBe("rate_limited"); // batas per workspace
    expect(await code(bookPublic(pool, b.slug, "sesi", guest({ email: `m.angsa-${sfx}@gmail.com`.replace("m.angsa", "mangsa") }), base))).toBe("rate_limited"); // batas global/alias
  });

  it("BOOKING: tebakan slot gagal TIDAK menguras kuota harian workspace; hanya pemesanan sah yang dihitung", async () => {
    const w = await bookableWorkspace("kuota");
    const original = PUBLIC_LIMITS.perWorkspacePerDay;
    (PUBLIC_LIMITS as { perWorkspacePerDay: number }).perWorkspacePerDay = 3;
    try {
      for (let i = 0; i < 6; i++) expect(await code(bookPublic(pool, w.slug, "sesi", guest({ startsAt: new Date("2035-03-05T02:30:00Z") }), base))).toBe("slot_unavailable");
      for (let i = 0; i < 3; i++) expect(await code(bookPublic(pool, w.slug, "sesi", guest(), base))).toBe("ok");
      expect(await code(bookPublic(pool, w.slug, "sesi", guest(), base))).toBe("rate_limited");
    } finally {
      (PUBLIC_LIMITS as { perWorkspacePerDay: number }).perWorkspacePerDay = original;
    }
  });

  it("klien yang diblokir (akun terdaftar) tidak bisa menyiasatinya dengan memesan sebagai tamu", async () => {
    const w = await bookableWorkspace("blokir");
    const client = await mkUser("terblokir");
    await pool.query(`INSERT INTO workspace_clients (workspace_id, user_id, name, email) SELECT id, $1, 'Terblokir', $2 FROM workspaces WHERE slug = $3`, [client.id, client.email, w.slug]);
    const id = (await listClients(pool, w.actor)).find((c) => c.userId === client.id)!.id;
    await setClientBlocked(pool, w.actor, id, true);
    expect(await code(bookPublic(pool, w.slug, "sesi", guest({ email: client.email }), base))).toBe("forbidden");
    expect(await code(bookPublic(pool, w.slug, "sesi", guest({ email: client.email.toUpperCase() }), base))).toBe("forbidden"); // huruf besar/kecil
    await setClientBlocked(pool, w.actor, id, false);
    expect(await code(bookPublic(pool, w.slug, "sesi", guest({ email: client.email }), base))).toBe("ok");
  });

  it("teks lokasi bebas (tatap muka) tidak ikut ke email tamu; link dan telepon tetap", async () => {
    const w = await bookableWorkspace("lokasi", "in_person", "KLIK https://phishing.example/login SEKARANG");
    const g = guest();
    await bookPublic(pool, w.slug, "sesi", g, base);
    const rows = (await pool.query(`SELECT payload::text AS p FROM notification_outbox WHERE recipient = $1`, [g.email.toLowerCase()])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.p).not.toContain("phishing");
      expect(r.p).toContain("lihat di halaman kelola booking");
    }
  });

  it("nomor HP dinormalisasi juga saat profil diubah (update-user), dan nilai tak valid ditolak", async () => {
    const auth = createAuth({ pool, secret: "x".repeat(40), baseURL: "http://localhost:3000" });
    const ip = `10.55.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const post = (path: string, body: unknown, cookie?: string) =>
      auth.handler(new Request(`http://localhost:3000/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
    const email = `profil-${sfx}@abuse.local`;
    await post("/sign-up/email", { name: "Profil", email, password: "kata-sandi-panjang-1", termsAccepted: true });
    await pool.query(`UPDATE users SET email_verified = true WHERE email = $1`, [email]);
    const login = await post("/sign-in/email", { email, password: "kata-sandi-panjang-1", termsAccepted: true });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const digits = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join(""); // unik per run
    const local = `0812${digits}`;
    expect((await post("/update-user", { phone: `${local.slice(0, 4)}-${local.slice(4)}` }, cookie)).status).toBe(200);
    expect((await pool.query(`SELECT phone FROM users WHERE email = $1`, [email])).rows[0].phone).toBe(`62${local.slice(1)}`);
    expect((await post("/update-user", { phone: "bukan nomor" }, cookie)).status).toBe(400);
    expect((await pool.query(`SELECT phone FROM users WHERE email = $1`, [email])).rows[0].phone).toBe(`62${local.slice(1)}`); // tak berubah

    // nomor milik akun lain: ditolak dengan pesan jelas (bukan 500) dan tidak mengubah apa pun
    const other = `other-${sfx}@abuse.local`;
    await post("/sign-up/email", { name: "Lain", email: other, password: "kata-sandi-panjang-1", termsAccepted: true });
    await pool.query(`UPDATE users SET email_verified = true WHERE email = $1`, [other]);
    const otherCookie = (await post("/sign-in/email", { email: other, password: "kata-sandi-panjang-1", termsAccepted: true })).headers.get("set-cookie")!.split(";")[0]!;
    const squat = await post("/update-user", { phone: local }, otherCookie);
    expect(squat.status).toBe(400);
    expect((await pool.query(`SELECT phone FROM users WHERE email = $1`, [other])).rows[0].phone).toBeNull();
  });
});
