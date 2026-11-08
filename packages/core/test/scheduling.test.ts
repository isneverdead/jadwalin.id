import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inviteAndAccept } from "./helpers";
import {
  addClient,
  addOverride,
  AppError,
  cancelBooking,
  createBooking,
  createMeetingType,
  createWorkspace,
  getWeeklyAvailability,
  listAvailableSlots,
  listMeetingTypes,
  listOverrides,
  removeOverride,
  setMeetingTypeActive,
  setWeeklyAvailability,
} from "../src";

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);
// Senin 2035-03-05 07:00 WIB
const NOW = new Date("2035-03-05T00:00:00Z");
const iso = (slots: { start: Date }[]) => slots.map((s) => s.start.toISOString());

describe.skipIf(!url)("mesin jadwal (Postgres asli)", () => {
  let pool: pg.Pool;
  const u = {} as Record<"owner" | "staff" | "outsider", string>;
  let slug: string;
  let otherSlug: string;
  let typeId: string;
  let clientId: string;
  let otherClientId: string;
  let ownerMember: string;
  let staffMember: string;
  const owner = () => ({ userId: u.owner, slug });
  const staff = () => ({ userId: u.staff, slug });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    for (const k of ["owner", "staff", "outsider"] as const) {
      u[k] = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [`${k}-${sfx}@sched.local`, k])).rows[0].id;
    }
    slug = `jadwal-${sfx}`;
    otherSlug = `lain-${sfx}`;
    await createWorkspace(pool, u.owner, { name: "Jadwal", slug });
    await createWorkspace(pool, u.outsider, { name: "Lain", slug: otherSlug });
    await inviteAndAccept(pool, owner(), { userId: u.staff, email: `staff-${sfx}@sched.local`, role: "staff" });
    ownerMember = (await pool.query(`SELECT id FROM workspace_members WHERE user_id = $1 AND workspace_id = (SELECT id FROM workspaces WHERE slug = $2)`, [u.owner, slug])).rows[0].id;
    staffMember = (await pool.query(`SELECT id FROM workspace_members WHERE user_id = $1 AND workspace_id = (SELECT id FROM workspaces WHERE slug = $2)`, [u.staff, slug])).rows[0].id;
    clientId = (await addClient(pool, owner(), { name: "Klien" })).id;
    otherClientId = (await addClient(pool, { userId: u.outsider, slug: otherSlug }, { name: "Klien Lain" })).id;
    typeId = (
      await createMeetingType(pool, owner(), { slug: "konsultasi", title: "Konsultasi", durationMin: 60, slotStepMin: 60, minNoticeMin: 0, maxDaysAhead: 7, locationKind: "link", locationValue: "https://meet.example.com/abc" })
    ).id;
    await setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
  });
  afterAll(async () => pool?.end());

  it("jenis pertemuan: hanya admin+, validasi input, kode unik", async () => {
    expect(await code(createMeetingType(pool, staff(), { slug: "x1", title: "Xx", durationMin: 30, locationKind: "link" }))).toBe("forbidden");
    expect(await code(createMeetingType(pool, owner(), { slug: "x1", title: "Xx", durationMin: 0, locationKind: "link" }))).toBe("invalid_input");
    expect(await code(createMeetingType(pool, owner(), { slug: "x1", title: "Xx", durationMin: 30, locationKind: "link", locationValue: "bukan url" }))).toBe("invalid_input");
    expect(await code(createMeetingType(pool, owner(), { slug: "x1", title: "Xx", durationMin: 30, locationKind: "link", locationValue: "javascript:alert(1)" }))).toBe("invalid_input");
    expect(await code(createMeetingType(pool, owner(), { slug: "konsultasi", title: "Dup", durationMin: 30, locationKind: "link" }))).toBe("slug_taken");
    expect(await code(createMeetingType(pool, owner(), { slug: "telp", title: "Telepon", durationMin: 30, locationKind: "phone", locationValue: "0812-3456-7000" }))).toBe("ok");
    expect((await listMeetingTypes(pool, staff())).map((t) => t.slug)).toContain("telp");
    expect(await code(listMeetingTypes(pool, { userId: u.outsider, slug }))).toBe("not_found");
  });

  it("ketersediaan: tumpang tindih ditolak, staf hanya mengatur dirinya, admin mengatur siapa saja", async () => {
    expect(
      await code(setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "09:00", end: "11:00" }, { weekday: 1, start: "10:00", end: "12:00" }] })),
    ).toBe("invalid_input");
    expect(await code(setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 9, start: "09:00", end: "11:00" }] }))).toBe("invalid_input");
    expect(await code(setWeeklyAvailability(pool, staff(), { memberId: ownerMember, rules: [] }))).toBe("forbidden");
    expect(await code(setWeeklyAvailability(pool, staff(), { rules: [{ weekday: 2, start: "13:00", end: "15:00" }] }))).toBe("ok");
    expect(await getWeeklyAvailability(pool, staff())).toEqual([{ weekday: 2, start: "13:00", end: "15:00" }]);
    expect(await code(setWeeklyAvailability(pool, owner(), { memberId: staffMember, rules: [] }))).toBe("ok");
    // milik owner tidak terhapus oleh perubahan milik staf
    expect(await getWeeklyAvailability(pool, owner())).toEqual([{ weekday: 1, start: "09:00", end: "12:00" }]);
  });

  it("override: validasi, tampil di daftar, staf tak bisa menghapus milik orang lain", async () => {
    expect(await code(addOverride(pool, owner(), { date: "2035-13-40", kind: "blocked" }))).toBe("invalid_input");
    expect(await code(addOverride(pool, owner(), { date: "2035-03-12", kind: "extra" }))).toBe("invalid_input");
    expect(await code(addOverride(pool, owner(), { date: "2035-03-12", kind: "blocked", start: "10:00" }))).toBe("invalid_input");
    expect(await code(addOverride(pool, owner(), { date: "2035-03-12", kind: "blocked", start: "11:00", end: "10:00" }))).toBe("invalid_input");
    const { id } = await addOverride(pool, owner(), { date: "2035-03-12", kind: "blocked" });
    expect((await listOverrides(pool, owner(), { now: NOW })).map((o) => o.id)).toContain(id);
    expect(await code(removeOverride(pool, staff(), id))).toBe("forbidden");
    await removeOverride(pool, owner(), id);
    expect((await listOverrides(pool, owner(), { now: NOW })).map((o) => o.id)).not.toContain(id);
  });

  it("slot dihitung dari jam rutin dan zona waktu workspace", async () => {
    const slots = await listAvailableSlots(pool, owner(), { meetingTypeId: typeId, now: NOW });
    expect(iso(slots).slice(0, 3)).toEqual(["2035-03-05T02:00:00.000Z", "2035-03-05T03:00:00.000Z", "2035-03-05T04:00:00.000Z"]);
  });

  it("zona waktu tak didukung ditolak oleh database; WITA menggeser slot", async () => {
    await expect(pool.query(`UPDATE workspaces SET timezone = 'America/New_York' WHERE slug = $1`, [slug])).rejects.toThrow(/workspaces_timezone_valid/);
    await pool.query(`UPDATE workspaces SET timezone = 'Asia/Makassar' WHERE slug = $1`, [slug]);
    const wita = await listAvailableSlots(pool, owner(), { meetingTypeId: typeId, now: NOW });
    expect(iso(wita)[0]).toBe("2035-03-05T01:00:00.000Z"); // 09:00 WITA
    await pool.query(`UPDATE workspaces SET timezone = 'Asia/Jakarta' WHERE slug = $1`, [slug]);
  });

  it("booking: slot hilang setelah diambil, bersebelahan boleh, batal membebaskan", async () => {
    const t2 = new Date("2035-03-05T03:00:00Z");
    const b = await createBooking(pool, owner(), { meetingTypeId: typeId, clientId, startsAt: t2, now: NOW });
    expect(iso(await listAvailableSlots(pool, owner(), { meetingTypeId: typeId, now: NOW }))).not.toContain(t2.toISOString());
    expect(await code(createBooking(pool, owner(), { meetingTypeId: typeId, clientId, startsAt: t2, now: NOW }))).toBe("slot_unavailable");
    expect(await code(createBooking(pool, owner(), { meetingTypeId: typeId, clientId, startsAt: new Date("2035-03-05T02:00:00Z"), now: NOW }))).toBe("ok"); // bersebelahan
    expect(await code(createBooking(pool, owner(), { meetingTypeId: typeId, clientId, startsAt: new Date("2035-03-05T03:30:00Z"), now: NOW }))).toBe("slot_unavailable"); // bukan slot
    await cancelBooking(pool, owner(), b.id);
    expect(iso(await listAvailableSlots(pool, owner(), { meetingTypeId: typeId, now: NOW }))).toContain(t2.toISOString());
    expect(await code(cancelBooking(pool, owner(), b.id))).toBe("invalid_input"); // sudah tidak aktif
  });

  it("buffer menempel pada booking: jarak antar pertemuan = buffer sesudah + buffer sebelum", async () => {
    const buf = await createMeetingType(pool, owner(), { slug: "buffered", title: "Dengan buffer", durationMin: 30, slotStepMin: 30, bufferBeforeMin: 30, bufferAfterMin: 30, minNoticeMin: 0, maxDaysAhead: 7, locationKind: "in_person", locationValue: "Kantor" });
    await setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "13:00", end: "16:00" }] });
    try {
      const before = iso(await listAvailableSlots(pool, owner(), { meetingTypeId: buf.id, now: NOW }));
      expect(before).toHaveLength(6); // 13:00 … 15:30 WIB, tiap 30 menit
      // Booking 14:00–14:30 WIB menempati 13:30–15:00 (dengan buffer).
      await createBooking(pool, owner(), { meetingTypeId: buf.id, clientId, startsAt: new Date("2035-03-05T07:00:00Z"), now: NOW });
      const after = iso(await listAvailableSlots(pool, owner(), { meetingTypeId: buf.id, now: NOW }));
      // Kandidat harus punya [mulai-30, selesai+30) yang tidak menyentuh 13:30–15:00:
      // 13:00 (rentang 12:30–14:00) dan semua sampai 15:00 bentrok; hanya 15:30 yang aman.
      expect(after).toEqual(["2035-03-05T08:30:00.000Z"]);
    } finally {
      await setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    }
  });

  it("KONKURENSI: 8 booking serentak pada slot yang sama, tepat satu berhasil", async () => {
    const startsAt = new Date("2035-03-05T04:00:00Z");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createBooking(pool, owner(), { meetingTypeId: typeId, clientId, startsAt, now: NOW })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const f of failed) expect(f.reason).toBeInstanceOf(AppError); // semua gagal sebagai slot_unavailable, bukan error mentah
    expect(failed.every((f) => (f.reason as AppError).code === "slot_unavailable")).toBe(true);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE member_id = $1 AND status = 'confirmed' AND lower(during) = $2`, [ownerMember, startsAt]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("isolasi: klien workspace lain tak bisa dipakai, bukan anggota tak bisa memesan, jenis nonaktif tak punya slot", async () => {
    const startsAt = new Date("2035-03-05T02:00:00Z");
    expect(await code(createBooking(pool, owner(), { meetingTypeId: typeId, clientId: otherClientId, startsAt, now: NOW }))).toBe("not_found");
    expect(await code(createBooking(pool, { userId: u.outsider, slug }, { meetingTypeId: typeId, clientId, startsAt, now: NOW }))).toBe("not_found");
    expect(await code(listAvailableSlots(pool, { userId: u.outsider, slug: otherSlug }, { meetingTypeId: typeId, now: NOW }))).toBe("not_found");
    await setMeetingTypeActive(pool, owner(), typeId, false);
    expect(await code(listAvailableSlots(pool, owner(), { meetingTypeId: typeId, now: NOW }))).toBe("not_found");
    await setMeetingTypeActive(pool, owner(), typeId, true);
  });

  it("audit log mencatat jadwal dan booking", async () => {
    const r = await pool.query(`SELECT DISTINCT action FROM audit_log WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = $1)`, [slug]);
    const actions = r.rows.map((x) => x.action);
    for (const a of ["meeting_type.created", "availability.replaced", "availability.override_added", "booking.created", "booking.cancelled"]) {
      expect(actions).toContain(a);
    }
  });
});
