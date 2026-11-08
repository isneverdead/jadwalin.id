import {
  AppError,
  bookPublic,
  cancelBookingByToken,
  createMeetingType,
  createWorkspace,
  listMyClientWorkspaces,
  rescheduleBookingByToken,
  setClientBlocked,
  listClients,
  setWeeklyAvailability,
} from "@jadwalin/core";
import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookAsClient, createClientTicket, getMyTicket, getTicket, listMyTickets, ticketBookingHooks } from "../src";
import { mkUser, outboxFor } from "./helpers";

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);
const opts = { baseUrl: "http://t.local" };
const NOW = new Date("2035-03-05T00:00:00Z"); // Senin 07:00 WIB
const hooks = ticketBookingHooks();
const base = { ...opts, now: NOW, hooks };

describe.skipIf(!url)("booking → tiket (Postgres asli)", () => {
  let pool: pg.Pool;
  let slug: string;
  let wsId: string;
  let ownerMember: string;
  const u = {} as Record<"owner" | "clientA" | "clientB" | "unverified", { id: string; email: string }>;
  const owner = () => ({ userId: u.owner.id, slug });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));

  let slotN = 0;
  const slot = () => {
    const i = slotN++;
    return new Date(Date.UTC(2035, 2, 5 + 7 * (1 + Math.floor(i / 3)), 2 + (i % 3)));
  };
  let n = 0;
  const guest = (extra: Record<string, unknown> = {}) => ({ name: "Tamu Tiket", email: `tamu${++n}-${sfx}@bt.local`, topic: "Konsultasi pajak", notes: "Ada pertanyaan soal SPT.", startsAt: slot(), privacyAck: true, ...extra }) as Parameters<typeof bookPublic>[3];

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    for (const k of ["owner", "clientA", "clientB"] as const) u[k] = await mkUser(pool, k, sfx);
    u.unverified = await mkUser(pool, "unverified", sfx, false);
    slug = `bt-${sfx}`;
    wsId = (await createWorkspace(pool, u.owner.id, { name: "Praktik Booking", slug })).id;
    ownerMember = (await pool.query(`SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [wsId, u.owner.id])).rows[0].id;
    await setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    await createMeetingType(pool, owner(), { slug: "konsultasi", title: "Konsultasi 60 menit", durationMin: 60, slotStepMin: 60, minNoticeMin: 60, maxDaysAhead: 90, locationKind: "link", locationValue: "https://meet.example.com/booking-tiket" });
  });
  afterAll(async () => pool?.end());

  describe("tamu tanpa akun", () => {
    it("setiap booking publik otomatis menjadi tiket baru milik host, dengan meeting tertaut dan riwayatnya", async () => {
      const g = guest();
      const r = await bookPublic(pool, slug, "konsultasi", g, base);
      expect(r.ticketId).toBeTruthy();

      const tickets = (await pool.query(`SELECT * FROM tickets WHERE id = $1`, [r.ticketId])).rows[0];
      expect(tickets).toMatchObject({ status: "open", requester_user_id: null, assignee_member_id: ownerMember, title: "Booking: Konsultasi 60 menit — Konsultasi pajak" });
      expect(tickets.description).toContain("Ada pertanyaan soal SPT.");
      expect((await pool.query(`SELECT ticket_id FROM bookings WHERE id = $1`, [r.bookingId])).rows[0].ticket_id).toBe(r.ticketId);

      const d = await getTicket(pool, owner(), tickets.number);
      expect(d.client).toMatchObject({ email: g.email, name: "Tamu Tiket" });
      expect(d.assignee?.memberId).toBe(ownerMember);
      expect(d.meetings).toHaveLength(1);
      expect(d.meetings[0]).toMatchObject({ title: "Konsultasi 60 menit", status: "confirmed", locationValue: "https://meet.example.com/booking-tiket" });
      expect(d.meetings[0]!.startsAt.toISOString()).toBe(r.startsAt.toISOString());
      expect(d.events.map((e) => [e.kind, e.actorName, e.clientVisible])).toEqual([["created", null, true], ["assign", null, false], ["meeting", null, true]]);
    });

    it("batal dan ubah jadwal lewat token tercatat di riwayat tiket", async () => {
      const a = slot();
      const b = slot();
      const r = await bookPublic(pool, slug, "konsultasi", guest({ startsAt: a }), base);
      const number = (await pool.query(`SELECT number FROM tickets WHERE id = $1`, [r.ticketId])).rows[0].number;

      await rescheduleBookingByToken(pool, r.manageToken, b, base);
      let d = await getTicket(pool, owner(), number);
      expect(d.meetings[0]!.startsAt.toISOString()).toBe(b.toISOString());
      expect(d.events.filter((e) => e.kind === "meeting").map((e) => e.to)).toEqual([a.toISOString(), b.toISOString()]);

      await cancelBookingByToken(pool, r.manageToken, base);
      d = await getTicket(pool, owner(), number);
      expect(d.meetings[0]!.status).toBe("cancelled");
      expect(d.events.at(-1)).toMatchObject({ kind: "meeting", to: "dibatalkan" });
      expect(d.ticket.status).toBe("open"); // tiket tetap terbuka untuk ditindaklanjuti staf
    });

    it("tanpa hook, booking publik tetap berhasil tanpa tiket (core tidak bergantung pada modul)", async () => {
      const r = await bookPublic(pool, slug, "konsultasi", guest(), { ...opts, now: NOW });
      expect(r.ticketId).toBeNull();
      expect((await pool.query(`SELECT ticket_id FROM bookings WHERE id = $1`, [r.bookingId])).rows[0].ticket_id).toBeNull();
    });

    it("hook yang gagal membatalkan seluruh booking (tidak ada booking tanpa tiket maupun sebaliknya)", async () => {
      const at = slot();
      const failing = { onBooked: async () => { throw new Error("hook rusak"); } };
      await expect(bookPublic(pool, slug, "konsultasi", guest({ startsAt: at }), { ...opts, now: NOW, hooks: failing })).rejects.toThrow("hook rusak");
      expect((await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE workspace_id = $1 AND starts_at = $2`, [wsId, at])).rows[0].n).toBe(0);
      expect(await code(bookPublic(pool, slug, "konsultasi", guest({ startsAt: at }), base))).toBe("ok"); // slot masih bebas
    });

    it("tamu kemudian mendaftar dengan email yang sama: tiketnya otomatis tertaut ke akunnya dan tampil di portal", async () => {
      const email = `pendaftar-${sfx}@bt.local`;
      const r = await bookPublic(pool, slug, "konsultasi", guest({ email }), base);
      const number = (await pool.query(`SELECT number FROM tickets WHERE id = $1`, [r.ticketId])).rows[0].number;

      const user = await mkUser(pool, "pendaftar", sfx); // email: pendaftar-<sfx>@tiket.local (beda domain) → ubah agar sama
      await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, user.id]);

      // Belum klaim → belum terlihat. Membuka portal memicu klaim.
      expect((await listMyClientWorkspaces(pool, user.id)).map((w) => w.slug)).toEqual([slug]);
      const mine = await listMyTickets(pool, user.id, slug);
      expect(mine.tickets.map((t) => t.number)).toEqual([number]);

      const view = await getMyTicket(pool, user.id, slug, number);
      expect(view.meetings).toHaveLength(1);
      expect(view.meetings[0]).toMatchObject({ locationValue: "https://meet.example.com/booking-tiket", memberName: null });
      expect(view.events.map((e) => e.kind)).toEqual(["created", "meeting"]); // penugasan tersembunyi dari klien
    });

    it("akun belum terverifikasi tidak mengklaim apa pun, walau emailnya sama", async () => {
      const email = `belum-${sfx}@bt.local`;
      const r = await bookPublic(pool, slug, "konsultasi", guest({ email }), base);
      const user = await mkUser(pool, "belum", sfx, false);
      await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, user.id]);
      expect(await listMyClientWorkspaces(pool, user.id)).toEqual([]);
      expect(await code(listMyTickets(pool, user.id, slug))).toBe("not_found");
      expect((await pool.query(`SELECT requester_user_id FROM tickets WHERE id = $1`, [r.ticketId])).rows[0].requester_user_id).toBeNull();
    });
  });

  describe("klien terdaftar (portal)", () => {
    let existing: number;
    it("memesan dengan tiket baru: tiket, booking, tautan, riwayat, dan email dibuat sekaligus", async () => {
      const at = slot();
      const r = await bookAsClient(pool, u.clientA.id, slug, "konsultasi", { startsAt: at, topic: "Diskusi proyek", notes: "Mohon siapkan agenda." }, { ...opts, now: NOW });
      existing = r.ticketNumber;
      const view = await getMyTicket(pool, u.clientA.id, slug, r.ticketNumber);
      expect(view.ticket.title).toBe("Booking: Konsultasi 60 menit — Diskusi proyek");
      expect(view.meetings[0]!.startsAt.toISOString()).toBe(at.toISOString());
      expect(view.events.map((e) => e.kind)).toEqual(["created", "meeting"]);
      const row = (await pool.query(`SELECT source, ticket_id FROM bookings WHERE id = $1`, [r.bookingId])).rows[0];
      expect(row.source).toBe("client_portal");
      expect(row.ticket_id).not.toBeNull();
      expect((await outboxFor(pool, u.clientA.email)).length).toBe(0); // klien memakai template booking_notice, bukan generic_notice
      const notices = (await pool.query(`SELECT payload->>'subject' AS subject, payload->>'url' AS url FROM notification_outbox WHERE recipient = $1 AND template = 'booking_notice'`, [u.clientA.email.toLowerCase()])).rows;
      expect(notices.some((x) => x.subject.startsWith("Booking terkonfirmasi") && x.url === `http://t.local/booking/${r.manageToken}`)).toBe(true);
      expect((await outboxFor(pool, u.owner.email)).some((m) => m.payload.subject.startsWith("Booking baru: clientA"))).toBe(true);
    });

    it("menempelkan meeting ke tiket yang sudah ada tanpa membuat tiket baru", async () => {
      const before = (await pool.query(`SELECT count(*)::int AS n FROM tickets WHERE workspace_id = $1`, [wsId])).rows[0].n;
      const at = slot();
      const r = await bookAsClient(pool, u.clientA.id, slug, "konsultasi", { startsAt: at, ticketNumber: existing }, { ...opts, now: NOW });
      expect(r.ticketNumber).toBe(existing);
      expect((await pool.query(`SELECT count(*)::int AS n FROM tickets WHERE workspace_id = $1`, [wsId])).rows[0].n).toBe(before);
      const view = await getMyTicket(pool, u.clientA.id, slug, existing);
      expect(view.meetings).toHaveLength(2);
    });

    it("tiket orang lain, tiket tak ada, dan tiket ditutup ditolak; slot bentrok tidak meninggalkan tiket yatim", async () => {
      const b = await createClientTicket(pool, u.clientB.id, slug, { title: "Tiket klien B" }, opts);
      expect(await code(bookAsClient(pool, u.clientA.id, slug, "konsultasi", { startsAt: slot(), ticketNumber: b.number }, { ...opts, now: NOW }))).toBe("not_found");
      expect(await code(bookAsClient(pool, u.clientA.id, slug, "konsultasi", { startsAt: slot(), ticketNumber: 999999 }, { ...opts, now: NOW }))).toBe("not_found");

      const taken = slot();
      await bookAsClient(pool, u.clientB.id, slug, "konsultasi", { startsAt: taken, topic: "Duluan" }, { ...opts, now: NOW });
      const ticketsBefore = (await pool.query(`SELECT count(*)::int AS n FROM tickets WHERE workspace_id = $1`, [wsId])).rows[0].n;
      expect(await code(bookAsClient(pool, u.clientA.id, slug, "konsultasi", { startsAt: taken, topic: "Terlambat" }, { ...opts, now: NOW }))).toBe("slot_unavailable");
      expect((await pool.query(`SELECT count(*)::int AS n FROM tickets WHERE workspace_id = $1`, [wsId])).rows[0].n).toBe(ticketsBefore); // atomik: tak ada tiket yatim
    });

    it("validasi, akun belum terverifikasi, klien diblokir, dan pembatas harian", async () => {
      expect(await code(bookAsClient(pool, u.clientA.id, slug, "konsultasi", { startsAt: slot(), topic: "ab" }, { ...opts, now: NOW }))).toBe("invalid_input");
      expect(await code(bookAsClient(pool, u.clientA.id, slug, "konsultasi", { startsAt: new Date("tidak valid"), topic: "Topik valid" }, { ...opts, now: NOW }))).toBe("invalid_input");
      expect(await code(bookAsClient(pool, u.clientA.id, slug, "tidak-ada", { startsAt: slot(), topic: "Topik valid" }, { ...opts, now: NOW }))).toBe("not_found");
      expect(await code(bookAsClient(pool, u.unverified.id, slug, "konsultasi", { startsAt: slot(), topic: "Topik valid" }, { ...opts, now: NOW }))).toBe("forbidden");

      const c = (await listClients(pool, owner())).find((x) => x.userId === u.clientB.id)!;
      await setClientBlocked(pool, owner(), c.id, true);
      expect(await code(bookAsClient(pool, u.clientB.id, slug, "konsultasi", { startsAt: slot(), topic: "Saat diblokir" }, { ...opts, now: NOW }))).toBe("forbidden");
      await setClientBlocked(pool, owner(), c.id, false);

      const heavy = await mkUser(pool, "heavy", sfx);
      const day = new Date("2035-03-05T00:10:00Z");
      for (let i = 0; i < 10; i++) await bookAsClient(pool, heavy.id, slug, "konsultasi", { startsAt: slot(), topic: `Pesan ${i}` }, { ...opts, now: day });
      expect(await code(bookAsClient(pool, heavy.id, slug, "konsultasi", { startsAt: slot(), topic: "Kesebelas" }, { ...opts, now: day }))).toBe("rate_limited");
    });
  });
});
