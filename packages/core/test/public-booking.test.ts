import { createPool, withTenant, withWorker } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  bookPublic,
  cancelBookingByToken,
  claimGuestRecords,
  consumeRateLimit,
  createMeetingType,
  createWorkspace,
  getBookingByToken,
  getPublicOverview,
  hashToken,
  listClients,
  listMeetingTypeHosts,
  listPublicSlots,
  listRescheduleSlots,
  rateKey,
  rescheduleBookingByToken,
  setClientBlocked,
  setMeetingTypeActive,
  setMeetingTypeHosts,
  setWeeklyAvailability,
  verifyTurnstile,
} from "../src";
import { inviteAndAccept } from "./helpers";

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);
const base = { baseUrl: "http://t.local" };
// Senin 2035-03-05 07:00 WIB. Jam rutin Senin 09–12 WIB → slot 02:00Z, 03:00Z, 04:00Z tiap Senin.
const NOW = new Date("2035-03-05T00:00:00Z");
const MON1 = (h: number) => new Date(`2035-03-05T0${h}:00:00Z`);
const MON2 = (h: number) => new Date(`2035-03-12T0${h}:00:00Z`);

describe("verifyTurnstile (gagal tertutup)", () => {
  const ok = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  it("lolos hanya bila success === true", async () => {
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: ok({ success: true }) })).toBe(true);
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: ok({ success: false }) })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: ok({ success: "true" }) })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: ok({}) })).toBe(false);
  });
  it("token kosong/terlalu panjang tidak memanggil jaringan; galat jaringan, status buruk, dan JSON rusak = gagal", async () => {
    let called = 0;
    const spy = (async () => { called++; return new Response("{}"); }) as typeof fetch;
    expect(await verifyTurnstile({ secret: "s", token: "", fetchImpl: spy })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: null, fetchImpl: spy })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "x".repeat(3000), fetchImpl: spy })).toBe(false);
    expect(called).toBe(0);
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: (async () => { throw new Error("jaringan putus"); }) as typeof fetch })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: ok({ success: true }, 500) })).toBe(false);
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: (async () => new Response("bukan json")) as typeof fetch })).toBe(false);
  });
  it("mengirim secret, token, dan IP ke Cloudflare", async () => {
    let sent = "";
    await verifyTurnstile({ secret: "rahasia", token: "tok", ip: "1.2.3.4", fetchImpl: (async (_u: unknown, init?: RequestInit) => { sent = String(init?.body); return new Response(JSON.stringify({ success: true })); }) as typeof fetch });
    expect(new URLSearchParams(sent).get("secret")).toBe("rahasia");
    expect(new URLSearchParams(sent).get("response")).toBe("tok");
    expect(new URLSearchParams(sent).get("remoteip")).toBe("1.2.3.4");
  });
});

describe.skipIf(!url)("booking publik (Postgres asli)", () => {
  let pool: pg.Pool;
  const u = {} as Record<"owner" | "staff" | "outsider" | "verified" | "unverified", { id: string; email: string }>;
  let slug: string;
  let otherSlug: string;
  let wsId: string;
  let ownerMember: string;
  let staffMember: string;
  let typeId: string; // host: owner saja
  let teamTypeId: string; // host: owner + staf
  const owner = () => ({ userId: u.owner.id, slug });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));
  let n = 0;
  const guest = (extra: Record<string, unknown> = {}) => ({ name: "Tamu Uji", email: `tamu${++n}-${sfx}@pub.local`, topic: "Ingin konsultasi", startsAt: MON1(2), privacyAck: true, ...extra }) as Parameters<typeof bookPublic>[3];
  const outbox = async (to: string) => (await pool.query(`SELECT template, status, payload, send_at FROM notification_outbox WHERE recipient = $1 ORDER BY created_at`, [to.toLowerCase()])).rows as { template: string; status: string; payload: { subject: string; url: string }; send_at: Date }[];
  // Setiap tes memakai slot unik (Senin ke-1…12 × jam 09/10/11 WIB) supaya tidak saling mengganggu.
  let slotN = 0;
  const slot = () => {
    const i = slotN++;
    return new Date(Date.UTC(2035, 2, 5 + 7 * (1 + Math.floor(i / 3)), 2 + (i % 3)));
  };
  const iso = (d: Date) => d.toISOString();
  const slotStarts = async (type = "konsultasi", now = NOW) => ((await listPublicSlots(pool, slug, type, { now }))?.slots ?? []).map((s) => s.start.toISOString());

  async function mkUser(label: string, verified = true) {
    const email = `${label}-${sfx}@pub.local`;
    const r = await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, $3) RETURNING id`, [email, label, verified]);
    return { id: r.rows[0].id as string, email };
  }

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    for (const k of ["owner", "staff", "outsider"] as const) u[k] = await mkUser(k);
    u.verified = await mkUser("verified");
    u.unverified = await mkUser("unverified", false);
    slug = `publik-${sfx}`;
    otherSlug = `publik-lain-${sfx}`;
    wsId = (await createWorkspace(pool, u.owner.id, { name: "Praktik Publik", slug })).id;
    await createWorkspace(pool, u.outsider.id, { name: "Lain", slug: otherSlug });
    await inviteAndAccept(pool, owner(), { userId: u.staff.id, email: u.staff.email, role: "staff" });
    ownerMember = (await pool.query(`SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [wsId, u.owner.id])).rows[0].id;
    staffMember = (await pool.query(`SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [wsId, u.staff.id])).rows[0].id;
    const rules = [{ weekday: 1, start: "09:00", end: "12:00" }];
    await setWeeklyAvailability(pool, owner(), { rules });
    await setWeeklyAvailability(pool, { userId: u.staff.id, slug }, { rules });
    const mk = async (slugName: string, title: string) =>
      (await createMeetingType(pool, owner(), { slug: slugName, title, durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 90, locationKind: "link", locationValue: "https://meet.example.com/publik" })).id;
    typeId = await mk("konsultasi", "Konsultasi 60 menit");
    teamTypeId = await mk("tim", "Sesi tim");
    await setMeetingTypeHosts(pool, owner(), teamTypeId, [ownerMember, staffMember]);
  });
  afterAll(async () => pool?.end());

  // ---------- Etalase publik ----------

  it("halaman depan: hanya jenis aktif yang punya host; workspace tak dikenal → null", async () => {
    const o = await getPublicOverview(pool, slug);
    expect(o?.workspace.name).toBe("Praktik Publik");
    expect(o?.types.map((t) => t.slug).sort()).toEqual(["konsultasi", "tim"]);
    const noHost = await createMeetingType(pool, owner(), { slug: "tanpa-host", title: "Tanpa host", durationMin: 30, locationKind: "phone" });
    await setMeetingTypeHosts(pool, owner(), noHost.id, []);
    expect((await getPublicOverview(pool, slug))!.types.map((t) => t.slug)).not.toContain("tanpa-host");
    await setMeetingTypeActive(pool, owner(), noHost.id, false);
    expect(await getPublicOverview(pool, "tidak-ada-slug")).toBeNull();
    expect(await getPublicOverview(pool, slug.toUpperCase())).not.toBeNull(); // slug tak peka huruf besar
  });

  it("slot publik: gabungan slot host tanpa duplikat; jenis tak dikenal → null", async () => {
    const solo = await slotStarts("konsultasi");
    expect(solo.slice(0, 3)).toEqual(["2035-03-05T02:00:00.000Z", "2035-03-05T03:00:00.000Z", "2035-03-05T04:00:00.000Z"]);
    const team = await slotStarts("tim");
    expect(team).toEqual(solo); // dua host dengan jam sama → tetap satu entri per waktu
    expect(await listPublicSlots(pool, slug, "tidak-ada", { now: NOW })).toBeNull();
    expect(await listPublicSlots(pool, otherSlug, "konsultasi", { now: NOW })).toBeNull(); // jenis milik workspace lain tak bocor
  });

  it("host: hanya admin+ yang mengatur; anggota tak dikenal ditolak", async () => {
    expect(await code(setMeetingTypeHosts(pool, { userId: u.staff.id, slug }, teamTypeId, [staffMember]))).toBe("forbidden");
    expect(await code(setMeetingTypeHosts(pool, owner(), teamTypeId, ["00000000-0000-0000-0000-000000000000"]))).toBe("not_found");
    expect((await listMeetingTypeHosts(pool, owner())).filter((h) => h.meetingTypeId === teamTypeId).map((h) => h.memberId).sort()).toEqual([ownerMember, staffMember].sort());
  });

  // ---------- Memesan ----------

  it("tamu memesan: token hanya di email (DB menyimpan hash), klien tamu dibuat, konfirmasi + pengingat + email host", async () => {
    const at = slot();
    const g = guest({ startsAt: at, phone: "0812-5551-0001", notes: "Bawa dokumen SPT." });
    const r = await bookPublic(pool, slug, "konsultasi", g, { ...base, now: NOW });
    expect(r.manageToken.length).toBeGreaterThanOrEqual(30);
    expect(iso(r.startsAt)).toBe(iso(at));

    const row = (await pool.query(`SELECT cancel_token_hash, starts_at, ends_at, source, status, member_id FROM bookings WHERE id = $1`, [r.bookingId])).rows[0];
    expect(row.cancel_token_hash).toBe(hashToken(r.manageToken));
    expect(JSON.stringify(row)).not.toContain(r.manageToken);
    expect([row.source, row.status, row.member_id]).toEqual(["public_link", "confirmed", ownerMember]);
    expect(new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()).toBe(3600_000);

    const client = (await listClients(pool, owner())).find((c) => c.email === g.email)!;
    expect(client).toMatchObject({ name: "Tamu Uji", userId: null, phone: "6281255510001" });

    const mails = await outbox(g.email);
    expect(mails.map((m) => m.template)).toEqual(["booking_notice", "booking_notice", "booking_notice"]); // konfirmasi + 24 jam + 1 jam
    const bySubject = (prefix: string) => mails.find((m) => m.payload.subject.startsWith(prefix))!;
    const confirm = bySubject("Booking terkonfirmasi");
    expect(confirm.payload.subject).toBe("Booking terkonfirmasi: Konsultasi 60 menit");
    expect(confirm.payload.url).toBe(`http://t.local/booking/${r.manageToken}`);
    expect(new Date(bySubject("Pengingat: Konsultasi 60 menit besok").send_at).getTime()).toBe(at.getTime() - 24 * 3600_000);
    expect(new Date(bySubject("Pengingat: Konsultasi 60 menit 1 jam lagi").send_at).getTime()).toBe(at.getTime() - 3600_000);
    expect((await outbox(u.owner.email)).some((m) => m.payload.subject.startsWith("Booking baru: Tamu Uji"))).toBe(true);
    // token tamu tidak boleh bocor ke pihak lain
    expect((await outbox(u.staff.email)).some((m) => JSON.stringify(m.payload).includes(r.manageToken))).toBe(false);
    expect(JSON.stringify(await outbox(u.owner.email))).not.toContain(r.manageToken);
  });

  it("slot yang dipesan langsung hilang; jenis dengan dua host tetap menawarkannya sampai host kedua terpakai", async () => {
    const a = slot();
    const r = await bookPublic(pool, slug, "konsultasi", guest({ startsAt: a }), { ...base, now: NOW });
    expect(r.hostMemberId).toBe(ownerMember);
    expect(await slotStarts("konsultasi")).not.toContain(iso(a));
    expect(await code(bookPublic(pool, slug, "konsultasi", guest({ startsAt: a }), { ...base, now: NOW }))).toBe("slot_unavailable");

    // jenis tim: dua pemesanan ke slot yang sama dibagi ke dua host berbeda, ketiga ditolak
    const t = slot();
    const first = await bookPublic(pool, slug, "tim", guest({ startsAt: t }), { ...base, now: NOW });
    expect(await slotStarts("tim")).toContain(iso(t));
    const second = await bookPublic(pool, slug, "tim", guest({ startsAt: t }), { ...base, now: NOW });
    expect(new Set([first.hostMemberId, second.hostMemberId]).size).toBe(2);
    expect(await slotStarts("tim")).not.toContain(iso(t));
    expect(await code(bookPublic(pool, slug, "tim", guest({ startsAt: t }), { ...base, now: NOW }))).toBe("slot_unavailable");
  });

  it("KONKURENSI: 8 tamu berbeda memesan slot yang sama → tepat satu berhasil, sisanya 'slot tidak tersedia'", async () => {
    const target = slot();
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => bookPublic(pool, slug, "konsultasi", guest({ startsAt: target }), { ...base, now: NOW })));
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = res.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(failed).toHaveLength(7);
    for (const f of failed) expect((f.reason as AppError).code).toBe("slot_unavailable");
    expect((await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE workspace_id = $1 AND starts_at = $2 AND status = 'confirmed'`, [wsId, target])).rows[0].n).toBe(1);
  });

  it("validasi input dan slot palsu", async () => {
    const book = (g: Parameters<typeof bookPublic>[3]) => code(bookPublic(pool, slug, "konsultasi", g, { ...base, now: NOW }));
    expect(await book(guest({ email: "bukan-email" }))).toBe("invalid_input");
    expect(await book(guest({ name: "A" }))).toBe("invalid_input");
    expect(await book(guest({ topic: "ab" }))).toBe("invalid_input");
    expect(await book(guest({ phone: "123" }))).toBe("invalid_input");
    expect(await book(guest({ notes: "x".repeat(2001) }))).toBe("invalid_input");
    expect(await book(guest({ startsAt: new Date("tidak valid") }))).toBe("invalid_input");
    expect(await book(guest({ startsAt: new Date("2035-03-05T02:30:00Z") }))).toBe("slot_unavailable"); // bukan slot
    expect(await book(guest({ startsAt: new Date("2035-03-06T02:00:00Z") }))).toBe("slot_unavailable"); // Selasa: libur
    expect(await code(bookPublic(pool, "tidak-ada", "konsultasi", guest(), { ...base, now: NOW }))).toBe("not_found");
    expect(await code(bookPublic(pool, slug, "tidak-ada", guest(), { ...base, now: NOW }))).toBe("not_found");
  });

  it("PEMBATAS LAJU: 3 booking per email per hari, dan percobaan gagal per IP tetap dihitung", async () => {
    const email = `berulang-${sfx}@pub.local`;
    const day = new Date("2035-03-05T00:30:00Z");
    for (let i = 0; i < 3; i++) await bookPublic(pool, slug, "tim", guest({ email, startsAt: slot() }), { ...base, now: day });
    expect(await code(bookPublic(pool, slug, "tim", guest({ email, startsAt: slot() }), { ...base, now: day }))).toBe("rate_limited");
    // email dengan huruf besar/kecil berbeda dihitung sama
    expect(await code(bookPublic(pool, slug, "tim", guest({ email: email.toUpperCase(), startsAt: slot() }), { ...base, now: day }))).toBe("rate_limited");
    // hari berikutnya jendela baru
    expect(await code(bookPublic(pool, slug, "tim", guest({ email, startsAt: slot() }), { ...base, now: new Date("2035-03-06T01:00:00Z") }))).toBe("ok");

    const ip = `ip-${sfx}`;
    const bogus = new Date("2035-03-05T02:30:00Z");
    const attempts: string[] = [];
    for (let i = 0; i < 12; i++) attempts.push(await code(bookPublic(pool, slug, "konsultasi", guest({ startsAt: bogus }), { ...base, now: day, clientIdentity: ip })));
    expect(attempts.slice(0, 10).every((a) => a === "slot_unavailable")).toBe(true); // gagal, tapi tetap terhitung
    expect(attempts.slice(10)).toEqual(["rate_limited", "rate_limited"]);
    expect(await code(bookPublic(pool, slug, "konsultasi", guest({ startsAt: bogus }), { ...base, now: day, clientIdentity: `lain-${sfx}` }))).toBe("slot_unavailable"); // IP lain tak terdampak
  });

  it("pembatas laju generik: jendela bergulir dan kunci tak memuat data pribadi", async () => {
    const key = rateKey("uji", `rahasia@x.test|${sfx}`);
    expect(key).not.toContain("rahasia");
    const t0 = new Date("2035-01-01T00:00:00Z");
    for (let i = 1; i <= 3; i++) expect(await consumeRateLimit(pool, key, { limit: 3, windowSec: 60, now: t0 })).toBe(i);
    expect(await code(consumeRateLimit(pool, key, { limit: 3, windowSec: 60, now: t0 }))).toBe("rate_limited");
    expect(await consumeRateLimit(pool, key, { limit: 3, windowSec: 60, now: new Date(t0.getTime() + 61_000) })).toBe(1);
  });

  it("klien tamu yang diblokir tidak bisa memesan, dengan pesan yang tidak membocorkan alasan", async () => {
    const g = guest({ startsAt: slot() });
    await bookPublic(pool, slug, "tim", g, { ...base, now: NOW });
    const c = (await listClients(pool, owner())).find((x) => x.email === g.email)!;
    await setClientBlocked(pool, owner(), c.id, true);
    const err = await bookPublic(pool, slug, "tim", { ...g, startsAt: slot() }, { ...base, now: NOW }).catch((e) => e as AppError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("forbidden");
    expect((err as AppError).message).not.toMatch(/blokir/i);
  });

  // ---------- Kelola lewat token ----------

  it("token: hanya pemegang yang melihat booking; token acak/kosong tidak mendapat apa pun", async () => {
    const at = slot();
    const r = await bookPublic(pool, slug, "konsultasi", guest({ startsAt: at }), { ...base, now: NOW });
    const m = await getBookingByToken(pool, r.manageToken, NOW);
    expect(m).toMatchObject({ id: r.bookingId, status: "confirmed", canChange: true, type: { title: "Konsultasi 60 menit", locationValue: "https://meet.example.com/publik" }, workspace: { name: "Praktik Publik", slug } });
    expect(await getBookingByToken(pool, "token-acak-yang-salah", NOW)).toBeNull();
    expect(await getBookingByToken(pool, "", NOW)).toBeNull();
    expect(await getBookingByToken(pool, hashToken(r.manageToken), NOW)).toBeNull(); // hash bukan token
    expect((await getBookingByToken(pool, r.manageToken, new Date(at.getTime() + 3600_000)))?.canChange).toBe(false); // sudah lewat
  });

  it("batal: slot bebas lagi, pengingat dibatalkan, host & tamu diberi tahu; tidak bisa dibatalkan dua kali", async () => {
    const at = slot();
    const g = guest({ startsAt: at });
    const r = await bookPublic(pool, slug, "konsultasi", g, { ...base, now: NOW });
    expect(await slotStarts("konsultasi")).not.toContain(iso(at));
    const before = (await outbox(g.email)).filter((m) => m.status === "queued");
    expect(before.length).toBeGreaterThanOrEqual(3);

    await cancelBookingByToken(pool, r.manageToken, { ...base, now: NOW });
    expect(await slotStarts("konsultasi")).toContain(iso(at));
    const after = await outbox(g.email);
    expect(after.filter((m) => m.status === "cancelled")).toHaveLength(2); // 24 jam + 1 jam
    expect(after.some((m) => m.payload.subject.startsWith("Booking dibatalkan"))).toBe(true);
    expect((await outbox(u.owner.email)).some((m) => m.payload.subject.startsWith("Booking dibatalkan: Tamu Uji"))).toBe(true);
    expect(await code(cancelBookingByToken(pool, r.manageToken, { ...base, now: NOW }))).toBe("invalid_input");
    expect(await code(cancelBookingByToken(pool, "token-salah", { ...base, now: NOW }))).toBe("not_found");
  });

  it("ubah jadwal: pindah ke slot kosong, pengingat lama batal + baru dibuat; slot terpakai atau waktu lampau ditolak", async () => {
    const first = slot();
    const second = slot();
    const takenByOther = slot();
    await bookPublic(pool, slug, "konsultasi", guest({ startsAt: takenByOther }), { ...base, now: NOW });
    const g = guest({ startsAt: first });
    const r = await bookPublic(pool, slug, "konsultasi", g, { ...base, now: NOW });

    const options = (await listRescheduleSlots(pool, r.manageToken, NOW))!.map((s) => iso(s.start));
    expect(options).toContain(iso(first)); // booking sendiri tidak menghalangi jadwalnya
    expect(options).toContain(iso(second));
    expect(options).not.toContain(iso(takenByOther));

    await rescheduleBookingByToken(pool, r.manageToken, second, { ...base, now: NOW });
    const row = (await pool.query(`SELECT starts_at, ends_at FROM bookings WHERE id = $1`, [r.bookingId])).rows[0];
    expect(new Date(row.starts_at).toISOString()).toBe(iso(second));
    expect(new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()).toBe(3600_000);
    expect(await slotStarts("konsultasi")).toContain(iso(first)); // slot lama bebas
    expect(await slotStarts("konsultasi")).not.toContain(iso(second));
    const mails = await outbox(g.email);
    expect(mails.filter((m) => m.status === "cancelled")).toHaveLength(2); // pengingat lama (24 jam + 1 jam)
    expect(mails.some((m) => m.payload.subject.startsWith("Jadwal diubah"))).toBe(true);
    expect(mails.some((m) => m.status === "queued" && new Date(m.send_at).getTime() === second.getTime() - 3600_000)).toBe(true); // pengingat baru

    expect(await code(rescheduleBookingByToken(pool, r.manageToken, takenByOther, { ...base, now: NOW }))).toBe("slot_unavailable");
    expect(await code(rescheduleBookingByToken(pool, r.manageToken, new Date(second.getTime() + 1800_000), { ...base, now: NOW }))).toBe("slot_unavailable"); // bukan slot
    expect(await code(rescheduleBookingByToken(pool, r.manageToken, first, { ...base, now: new Date(second.getTime() + 60_000) }))).toBe("invalid_input"); // sudah lewat
    expect(await listRescheduleSlots(pool, "token-salah", NOW)).toBeNull();
  });

  // ---------- RLS aktor tamu ----------

  describe("RLS aktor 'public' (SQL mentah)", () => {
    const NIL = "00000000-0000-0000-0000-000000000000";
    const asPublic = <T>(fn: (q: (s: ReturnType<typeof sql>) => Promise<Record<string, unknown>[]>) => Promise<T>, ws: string | null = wsId, token?: string) =>
      withTenant(pool, { userId: NIL, workspaceId: ws ?? undefined, actor: "public", bookingTokenHash: token }, (db) => fn(async (q) => (await db.execute(q)).rows as Record<string, unknown>[]));
    const denied = (p: Promise<unknown>) => p.then(() => "ok", (e: { cause?: { message?: string }; message?: string }) => e.cause?.message ?? e.message ?? "error");

    it("tidak membaca tiket, komentar, lampiran, berkas, anggota, outbox, kuota, undangan, audit", async () => {
      for (const t of ["tickets", "ticket_comments", "ticket_attachments", "ticket_events", "ticket_meetings", "files", "workspace_members", "notification_outbox", "notification_quota_usage", "workspace_invitations", "audit_log"]) {
        expect(await asPublic((q) => q(sql.raw(`SELECT * FROM ${t}`))), t).toHaveLength(0);
      }
    });

    it("hanya membaca booking aktif (rentang waktu), jenis aktif, dan klien TAMU", async () => {
      await asPublic(async (q) => {
        expect((await q(sql`SELECT status FROM bookings`)).every((b) => b.status === "confirmed" || b.status === "pending")).toBe(true);
        expect((await q(sql`SELECT active FROM meeting_types`)).every((m) => m.active === true)).toBe(true);
        expect((await q(sql`SELECT user_id FROM workspace_clients`)).every((c) => c.user_id === null)).toBe(true);
        expect((await q(sql`SELECT slug FROM workspaces`)).map((w) => w.slug)).toEqual([slug]);
      });
    });

    it("tidak bisa menulis selain booking 'public_link' dan klien tamu; tidak bisa mengubah booking tanpa token", async () => {
      const mt = (await pool.query(`SELECT id FROM meeting_types WHERE workspace_id = $1 AND slug = 'konsultasi'`, [wsId])).rows[0].id;
      const anyClient = (await pool.query(`SELECT id FROM workspace_clients WHERE workspace_id = $1 LIMIT 1`, [wsId])).rows[0].id;
      const insertBooking = (source: string, hash: string) => sql`INSERT INTO bookings (workspace_id, meeting_type_id, member_id, client_id, during, starts_at, ends_at, source, cancel_token_hash) VALUES (${wsId}, ${mt}, ${ownerMember}, ${anyClient}, '[2036-01-01,2036-01-02)', '2036-01-01', '2036-01-02', ${source}, ${hash})`;
      expect(await denied(asPublic((q) => q(insertBooking("staff", `h1-${sfx}`))))).toMatch(/row-level security/);
      expect(await denied(asPublic((q) => q(insertBooking("public_link", `h2-${sfx}`))))).toBe("ok"); // jalur sah (jenis/anggota tidak diperiksa RLS)
      const writes: [string, ReturnType<typeof sql>][] = [
        ["tiket dengan pemilik", sql`INSERT INTO tickets (workspace_id, number, title, requester_user_id) VALUES (${wsId}, 88888, 'x', ${u.owner.id})`],
        ["klien terdaftar", sql`INSERT INTO workspace_clients (workspace_id, user_id, name) VALUES (${wsId}, ${u.owner.id}, 'x')`],
        ["klien diblokir", sql`INSERT INTO workspace_clients (workspace_id, name, blocked) VALUES (${wsId}, 'x', true)`],
        ["jenis pertemuan", sql`INSERT INTO meeting_types (workspace_id, slug, title, duration_min, location_kind) VALUES (${wsId}, 'palsu', 'x', 30, 'link')`],
        ["jam rutin", sql`INSERT INTO availability_rules (workspace_id, member_id, weekday, start_time, end_time) VALUES (${wsId}, ${ownerMember}, 2, '00:00', '23:00')`],
        ["host", sql`INSERT INTO meeting_type_hosts (workspace_id, meeting_type_id, member_id) VALUES (${wsId}, ${mt}, ${staffMember})`],
        ["outbox email", sql`INSERT INTO notification_outbox (workspace_id, channel, recipient, template) VALUES (${wsId}, 'email', 'korban@x.local', 'generic_notice')`],
        ["audit atas nama orang", sql`INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id) VALUES (${wsId}, ${u.owner.id}, 'x', 'x', 'x')`],
      ];
      for (const [label, q] of writes) expect(await denied(asPublic((run) => run(q))), label).toMatch(/row-level security/);
      const zero: [string, ReturnType<typeof sql>][] = [
        ["ubah booking orang lain", sql`UPDATE bookings SET status = 'cancelled' RETURNING id`],
        ["hapus booking", sql`DELETE FROM bookings RETURNING id`],
        ["ubah klien", sql`UPDATE workspace_clients SET blocked = false RETURNING id`],
        ["ubah workspace", sql`UPDATE workspaces SET name = 'diretas' RETURNING id`],
        ["ubah jenis", sql`UPDATE meeting_types SET active = false RETURNING id`],
      ];
      for (const [label, q] of zero) expect(await asPublic((run) => run(q)), label).toHaveLength(0);
    });

    it("token hanya membuka SATU booking; konteks workspace lain tidak melihat apa pun", async () => {
      const r = await bookPublic(pool, slug, "tim", guest({ startsAt: slot() }), { ...base, now: NOW });
      const rows = await asPublic((q) => q(sql`SELECT id FROM bookings`), null, hashToken(r.manageToken));
      expect(rows.map((x) => x.id)).toEqual([r.bookingId]); // tanpa konteks workspace: hanya booking milik token
      const other = (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [otherSlug])).rows[0].id;
      expect(await asPublic((q) => q(sql`SELECT * FROM bookings`), other)).toHaveLength(0);
      expect(await asPublic((q) => q(sql`SELECT * FROM meeting_types`), other)).toHaveLength(0);
    });
  });

  // ---------- Klaim klien tamu ----------

  describe("klaim klien tamu oleh pemilik email terverifikasi", () => {
    it("email terverifikasi yang sama → klien dan tiket diklaim; belum terverifikasi atau email beda → tidak", async () => {
      const email = u.verified.email;
      await bookPublic(pool, slug, "tim", guest({ email, startsAt: slot() }), { ...base, now: NOW });
      await pool.query(`INSERT INTO tickets (workspace_id, number, title, client_id) SELECT workspace_id, 7777, 'Tiket tamu', id FROM workspace_clients WHERE workspace_id = $1 AND email = $2`, [wsId, email]);

      expect(await claimGuestRecords(pool, u.outsider.id)).toEqual({ clients: 0, tickets: 0 }); // email beda
      const unverifiedGuest = guest({ email: u.unverified.email, startsAt: slot() });
      await bookPublic(pool, slug, "tim", unverifiedGuest, { ...base, now: NOW });
      expect(await claimGuestRecords(pool, u.unverified.id)).toEqual({ clients: 0, tickets: 0 }); // belum terverifikasi

      const r = await claimGuestRecords(pool, u.verified.id);
      expect(r.clients).toBe(1);
      expect(r.tickets).toBeGreaterThanOrEqual(1);
      const c = (await pool.query(`SELECT user_id FROM workspace_clients WHERE workspace_id = $1 AND email = $2`, [wsId, email])).rows[0];
      expect(c.user_id).toBe(u.verified.id);
      expect((await pool.query(`SELECT requester_user_id FROM tickets WHERE number = 7777 AND workspace_id = $1`, [wsId])).rows[0].requester_user_id).toBe(u.verified.id);
      expect(await claimGuestRecords(pool, u.verified.id)).toEqual({ clients: 0, tickets: 0 }); // idempoten
    });

    it("pengguna yang sudah punya catatan klien di workspace itu tidak memicu bentrok unik", async () => {
      const dup = await mkUser("dup");
      await pool.query(`INSERT INTO workspace_clients (workspace_id, user_id, name, email) VALUES ($1, $2, 'Sudah ada', $3)`, [wsId, dup.id, `lain-${sfx}@pub.local`]);
      await bookPublic(pool, slug, "tim", guest({ email: dup.email, startsAt: slot() }), { ...base, now: NOW });
      expect(await claimGuestRecords(pool, dup.id)).toEqual({ clients: 0, tickets: 0 });
    });
  });

  it("jejak audit booking publik tercatat tanpa aktor", async () => {
    const r = await withWorker(pool, async () => pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND action = 'booking.created_public' AND actor_user_id IS NULL`, [wsId]));
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
