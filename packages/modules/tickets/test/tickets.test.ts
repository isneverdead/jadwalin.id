import {
  AppError,
  addClient,
  createMeetingType,
  createWorkspace,
  listClients,
  setClientBlocked,
  setWeeklyAvailability,
  type StorageAdapter,
} from "@jadwalin/core";
import { createPool, withTenant } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addClientComment,
  addStaffComment,
  assignTicket,
  cancelTicketMeeting,
  confirmAttachment,
  confirmClientAttachment,
  createClientTicket,
  createTicket,
  downloadAttachment,
  downloadClientAttachment,
  getMyTicket,
  getTicket,
  listMyTickets,
  listTickets,
  requestAttachmentUpload,
  requestClientAttachmentUpload,
  scheduleTicketMeeting,
  setMyTicketStatus,
  setTicketPriority,
  setTicketStatus,
} from "../src";
import { inviteAndAccept, mkUser, outboxFor, testStorage } from "./helpers";

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);
const opts = { baseUrl: "http://t.local" };
// Senin 2035-03-05 07:00 WIB: jam rutin Senin 09–12 → slot 02:00Z, 03:00Z, 04:00Z
const NOW = new Date("2035-03-05T00:00:00Z");
const SLOT1 = new Date("2035-03-05T02:00:00Z");
const SLOT2 = new Date("2035-03-05T03:00:00Z");
const PDF = new TextEncoder().encode("%PDF-1.4 tiket");

describe.skipIf(!url)("modul tiket (Postgres asli)", () => {
  let pool: pg.Pool;
  let storage: StorageAdapter | null;
  const u = {} as Record<"owner" | "admin" | "staff" | "clientA" | "clientB" | "unverified" | "outsider", { id: string; email: string }>;
  let slug: string;
  let otherSlug: string;
  let wsId: string;
  let staffMemberId: string;
  let meetingTypeId: string;
  const owner = () => ({ userId: u.owner.id, slug });
  const staff = () => ({ userId: u.staff.id, slug });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));
  const nums = (rows: { number: number }[]) => rows.map((r) => r.number).sort((a, b) => a - b);

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    storage = testStorage();
    for (const k of ["owner", "admin", "staff", "clientA", "clientB", "outsider"] as const) u[k] = await mkUser(pool, k, sfx);
    u.unverified = await mkUser(pool, "unverified", sfx, false);
    slug = `tiket-${sfx}`;
    otherSlug = `tiket-lain-${sfx}`;
    wsId = (await createWorkspace(pool, u.owner.id, { name: "Praktik Tiket", slug })).id;
    await createWorkspace(pool, u.outsider.id, { name: "Lain", slug: otherSlug });
    await inviteAndAccept(pool, owner(), { userId: u.admin.id, email: u.admin.email, role: "admin" });
    await inviteAndAccept(pool, owner(), { userId: u.staff.id, email: u.staff.email, role: "staff" });
    staffMemberId = (await pool.query(`SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [wsId, u.staff.id])).rows[0].id;
    await setWeeklyAvailability(pool, owner(), { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    // Staf menjadwalkan di kalendernya sendiri (admin+ baru boleh di kalender orang lain).
    await setWeeklyAvailability(pool, staff(), { rules: [{ weekday: 1, start: "09:00", end: "12:00" }] });
    meetingTypeId = (await createMeetingType(pool, owner(), { slug: "konsultasi", title: "Konsultasi 60 menit", durationMin: 60, slotStepMin: 60, minNoticeMin: 0, maxDaysAhead: 7, locationKind: "link", locationValue: "https://meet.example.com/ruang-tiket" })).id;
  });
  afterAll(async () => pool?.end());

  // ---------- Klien membuat tiket ----------

  let t1: number;
  let t2: number;

  it("klien terverifikasi membuka tiket: catatan klien dibuat otomatis, nomor urut, riwayat 'created'", async () => {
    const a = await createClientTicket(pool, u.clientA.id, slug, { title: "  Butuh   konsultasi pajak  ", description: "Mohon dibantu SPT." }, opts);
    const b = await createClientTicket(pool, u.clientA.id, slug, { title: "Pertanyaan kedua" }, opts);
    t1 = a.number;
    t2 = b.number;
    expect(t2).toBe(t1 + 1);
    const view = await getMyTicket(pool, u.clientA.id, slug, t1);
    expect(view.ticket.title).toBe("Butuh konsultasi pajak"); // spasi dirapikan
    expect(view.ticket.status).toBe("open");
    expect(view.events.map((e) => e.kind)).toEqual(["created"]);
    expect((await listClients(pool, owner())).filter((c) => c.userId === u.clientA.id)).toHaveLength(1);
  });

  it("akun belum terverifikasi tidak bisa membuka tiket; input divalidasi", async () => {
    expect(await code(createClientTicket(pool, u.unverified.id, slug, { title: "Halo halo" }, opts))).toBe("forbidden");
    expect(await code(createClientTicket(pool, u.clientB.id, slug, { title: "ab" }, opts))).toBe("invalid_input");
    expect(await code(createClientTicket(pool, u.clientB.id, "tidak-ada-slug", { title: "Judul valid" }, opts))).toBe("not_found");
  });

  it("NOMOR URUT: 6 tiket serentak mendapat nomor berbeda dan berurutan tanpa celah", async () => {
    const before = nums(await listTickets(pool, owner(), { limit: 200 })).pop()!;
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => createClientTicket(pool, u.clientB.id, slug, { title: `Serentak ${i}` }, opts)));
    expect(res.map((r) => r.number).sort((a, b) => a - b)).toEqual([before + 1, before + 2, before + 3, before + 4, before + 5, before + 6]);
  });

  it("pembatas harian: tiket ke-11 dalam 24 jam ditolak", async () => {
    const spammer = await mkUser(pool, "spam", sfx);
    for (let i = 0; i < 10; i++) await createClientTicket(pool, spammer.id, slug, { title: `Spam ${i}` }, opts);
    expect(await code(createClientTicket(pool, spammer.id, slug, { title: "Spam sebelas" }, opts))).toBe("invalid_input");
  });

  // ---------- Staf ----------

  it("staf melihat semua tiket; filter status, penanggung jawab, dan pencarian bekerja", async () => {
    const all = await listTickets(pool, staff());
    expect(nums(all)).toEqual(expect.arrayContaining([t1, t2]));
    expect(all.find((t) => t.number === t1)!.clientName).toBe("clientA");
    expect(nums(await listTickets(pool, staff(), { q: "pajak" }))).toEqual([t1]);
    expect(nums(await listTickets(pool, staff(), { q: "%" }))).toEqual([]); // wildcard di-escape
    expect(nums(await listTickets(pool, staff(), { assignee: "me" }))).toEqual([]);
  });

  it("penugasan: ke anggota workspace, tercatat sebagai riwayat internal; anggota workspace lain ditolak", async () => {
    await assignTicket(pool, owner(), t1, staffMemberId, opts);
    expect(nums(await listTickets(pool, staff(), { assignee: "me" }))).toEqual([t1]);
    const foreign = (await pool.query(`SELECT id FROM workspace_members WHERE user_id = $1`, [u.outsider.id])).rows[0].id;
    expect(await code(assignTicket(pool, owner(), t1, foreign, opts))).toBe("not_found");
    const d = await getTicket(pool, owner(), t1);
    expect(d.assignee?.name).toBe("staff");
    const assignEvent = d.events.find((e) => e.kind === "assign")!;
    expect(assignEvent.clientVisible).toBe(false);
    // email ke penanggung jawab baru
    expect((await outboxFor(pool, u.staff.email)).some((m) => m.payload.subject.includes(`#${t1}`))).toBe(true);
  });

  it("status & prioritas: transisi sah, riwayat lengkap, closedAt hanya saat ditutup", async () => {
    await setTicketStatus(pool, staff(), t1, "in_progress", opts);
    expect(await code(setTicketStatus(pool, staff(), t1, "open", opts))).toBe("invalid_input"); // in_progress → open tidak diizinkan staf
    await setTicketPriority(pool, staff(), t1, "high");
    expect(await code(setTicketPriority(pool, staff(), t1, "kritis" as never))).toBe("invalid_input");
    const d = await getTicket(pool, staff(), t1);
    expect(d.ticket.priority).toBe("high");
    expect(d.ticket.closedAt).toBeNull();
    expect(d.events.map((e) => e.kind)).toEqual(["created", "assign", "status", "priority"]);
    expect(d.events.find((e) => e.kind === "status")).toMatchObject({ from: "open", to: "in_progress", actorName: "staff" });
  });

  it("komentar: internal tidak pernah terlihat klien (lewat layanan maupun SQL mentah); balasan publik mengirim email ke klien", async () => {
    const secret = "CATATAN-INTERNAL-RAHASIA-123";
    await addStaffComment(pool, staff(), t1, { body: secret, internal: true }, opts);
    await addStaffComment(pool, staff(), t1, { body: "Baik, kami cek dulu ya.", internal: false }, opts);
    expect(await code(addStaffComment(pool, staff(), t1, { body: "   " }, opts))).toBe("invalid_input");

    const staffView = await getTicket(pool, staff(), t1);
    expect(staffView.comments.map((c) => [c.internal, c.authorKind])).toEqual([[true, "staff"], [false, "staff"]]);

    const clientView = await getMyTicket(pool, u.clientA.id, slug, t1);
    expect(clientView.comments.map((c) => c.body)).toEqual(["Baik, kami cek dulu ya."]);
    expect(JSON.stringify(clientView)).not.toContain(secret);

    const raw = await withTenant(pool, { userId: u.clientA.id, workspaceId: wsId, actor: "client" }, (db) => db.execute(sql`SELECT body FROM ticket_comments`));
    expect(raw.rows.map((r) => r.body)).not.toContain(secret);

    const mails = await outboxFor(pool, u.clientA.email);
    expect(mails.some((m) => m.payload.paragraphs.includes("Baik, kami cek dulu ya."))).toBe(true);
    expect(mails.some((m) => JSON.stringify(m.payload).includes(secret))).toBe(false); // catatan internal tak pernah diemailkan
  });

  // ---------- Klien membalas ----------

  it("klien membalas: tiket 'menunggu klien' kembali ke 'open' dan staf diberi tahu; tidak bisa melompat status", async () => {
    await setTicketStatus(pool, staff(), t1, "waiting_client", opts);
    await addClientComment(pool, u.clientA.id, slug, t1, "Ini dokumen yang diminta.", opts);
    const d = await getTicket(pool, staff(), t1);
    expect(d.ticket.status).toBe("open");
    expect(d.comments.at(-1)).toMatchObject({ authorKind: "client", internal: false, body: "Ini dokumen yang diminta." });
    expect((await outboxFor(pool, u.staff.email)).some((m) => m.payload.heading.includes("membalas"))).toBe(true); // penanggung jawab
    expect(await code(setMyTicketStatus(pool, u.clientA.id, slug, t1, "open"))).toBe("invalid_input"); // open → open
    await setTicketStatus(pool, staff(), t1, "in_progress", opts);
  });

  it("BATAS KOMENTAR klien: 30 per jam per pengguna (melindungi kuota email workspace dari banjir)", async () => {
    const talker = await mkUser(pool, "cerewet", sfx);
    const t = await createClientTicket(pool, talker.id, slug, { title: "Tiket banyak bicara" }, opts);
    for (let i = 0; i < 30; i++) await addClientComment(pool, talker.id, slug, t.number, `pesan ${i}`, opts);
    expect(await code(addClientComment(pool, talker.id, slug, t.number, "pesan ke-31", opts))).toBe("rate_limited");
    expect((await getMyTicket(pool, talker.id, slug, t.number)).comments).toHaveLength(30); // yang ditolak tidak tersimpan
  });

  it("klien hanya bisa menutup/membuka tiketnya sendiri; tiket orang lain 'tidak ditemukan'", async () => {
    expect(await code(addClientComment(pool, u.clientB.id, slug, t1, "Menyusup", opts))).toBe("not_found");
    expect(await code(getMyTicket(pool, u.clientB.id, slug, t1))).toBe("not_found");
    expect(await code(setMyTicketStatus(pool, u.clientB.id, slug, t1, "closed"))).toBe("not_found");
    const bList = await listMyTickets(pool, u.clientB.id, slug);
    expect(bList.tickets.map((t) => t.number)).not.toContain(t1);
    expect(await code(listMyTickets(pool, u.outsider.id, slug))).toBe("not_found"); // bukan klien di sini
  });

  // ---------- Lampiran ----------

  describe.skipIf(!process.env.S3_ENDPOINT)("lampiran (S3 asli)", () => {
    const put = (up: { url: string; headers: Record<string, string> }, body: Uint8Array) => fetch(up.url, { method: "PUT", headers: up.headers, body: body as unknown as BodyInit });

    it("staf melampirkan dengan catatan konteks; klien hanya melihat yang ditandai terlihat; unduh terisolasi", async () => {
      const mk = async (name: string, note: string, clientVisible: boolean) => {
        const { fileId, upload } = await requestAttachmentUpload(pool, staff(), storage!, t1, { filename: name, mime: "application/pdf", sizeBytes: PDF.byteLength });
        expect((await put(upload, PDF)).ok).toBe(true);
        return confirmAttachment(pool, staff(), storage!, t1, { fileId, contextNote: note, clientVisible });
      };
      const visible = await mk("panduan-spt.pdf", "Contoh pengisian SPT", true);
      const hidden = await mk("analisis-internal.pdf", "Strategi internal", false);

      const staffView = await getTicket(pool, staff(), t1);
      expect(staffView.attachments.map((a) => [a.filename, a.contextNote, a.clientVisible])).toEqual(expect.arrayContaining([["panduan-spt.pdf", "Contoh pengisian SPT", true], ["analisis-internal.pdf", "Strategi internal", false]]));

      const clientView = await getMyTicket(pool, u.clientA.id, slug, t1);
      expect(clientView.attachments.map((a) => a.filename)).toEqual(["panduan-spt.pdf"]);
      expect(JSON.stringify(clientView)).not.toContain("Strategi internal");

      const dl = await downloadClientAttachment(pool, u.clientA.id, slug, storage!, t1, visible.id);
      expect(new Uint8Array(await (await fetch(dl.url)).arrayBuffer())).toEqual(PDF);
      expect(await code(downloadClientAttachment(pool, u.clientA.id, slug, storage!, t1, hidden.id))).toBe("not_found");
      expect(await code(downloadClientAttachment(pool, u.clientB.id, slug, storage!, t1, visible.id))).toBe("not_found");
      expect(await code(downloadAttachment(pool, staff(), storage!, t1, hidden.id))).toBe("ok");
      expect(await code(downloadAttachment(pool, { userId: u.outsider.id, slug }, storage!, t1, visible.id))).toBe("not_found");
    });

    it("klien melampirkan berkas ke tiketnya; berkas tak boleh dilampirkan dua kali atau ke tiket orang lain", async () => {
      const { fileId, upload } = await requestClientAttachmentUpload(pool, u.clientA.id, slug, storage!, t1, { filename: "bukti.pdf", mime: "application/pdf", sizeBytes: PDF.byteLength });
      await put(upload, PDF);
      const a = await confirmClientAttachment(pool, u.clientA.id, slug, storage!, t1, { fileId, contextNote: "Bukti transfer" });
      expect(await code(confirmClientAttachment(pool, u.clientA.id, slug, storage!, t1, { fileId }))).toBe("invalid_input"); // sudah terlampir
      expect(await code(requestClientAttachmentUpload(pool, u.clientB.id, slug, storage!, t1, { filename: "x.pdf", mime: "application/pdf", sizeBytes: 5 }))).toBe("not_found");
      const d = await getTicket(pool, staff(), t1);
      expect(d.attachments.find((x) => x.id === a.id)).toMatchObject({ contextNote: "Bukti transfer", uploadedByName: "clientA" });
      expect(d.events.some((e) => e.kind === "attachment" && e.to === "bukti.pdf")).toBe(true);
    });

    it("ukuran berkas tidak cocok ditolak; berkas pengguna lain tidak bisa dilampirkan", async () => {
      const { fileId, upload } = await requestAttachmentUpload(pool, staff(), storage!, t1, { filename: "bohong.pdf", mime: "application/pdf", sizeBytes: 5 });
      void upload;
      const key = (await pool.query(`SELECT storage_key FROM files WHERE id = $1`, [fileId])).rows[0].storage_key;
      await (storage as unknown as { putForTest(k: string, b: Uint8Array, m: string): Promise<void> }).putForTest(key, new Uint8Array(50), "application/pdf");
      expect(await code(confirmAttachment(pool, staff(), storage!, t1, { fileId }))).toBe("invalid_input");
      expect((await pool.query(`SELECT status FROM files WHERE id = $1`, [fileId])).rows[0].status).toBe("deleted"); // ikut commit

      const other = await requestAttachmentUpload(pool, owner(), storage!, t1, { filename: "milik-owner.pdf", mime: "application/pdf", sizeBytes: PDF.byteLength });
      await put(other.upload, PDF);
      expect(await code(confirmAttachment(pool, staff(), storage!, t1, { fileId: other.fileId }))).toBe("forbidden");
    });
  });

  // ---------- Meeting ----------

  it("meeting dari tiket: booking + tautan + riwayat + email ke klien; klien melihat waktu dan link", async () => {
    const m = await scheduleTicketMeeting(pool, staff(), t1, { meetingTypeId, startsAt: SLOT1, now: NOW }, opts);
    expect(m.startsAt.toISOString()).toBe(SLOT1.toISOString());

    const cv = await getMyTicket(pool, u.clientA.id, slug, t1);
    expect(cv.meetings).toHaveLength(1);
    expect(cv.meetings[0]).toMatchObject({ title: "Konsultasi 60 menit", locationKind: "link", locationValue: "https://meet.example.com/ruang-tiket", status: "confirmed", memberName: null });
    expect(cv.meetings[0]!.startsAt.toISOString()).toBe(SLOT1.toISOString());
    expect(cv.meetings[0]!.endsAt.toISOString()).toBe("2035-03-05T03:00:00.000Z");

    const d = await getTicket(pool, staff(), t1);
    expect(d.events.some((e) => e.kind === "meeting" && e.to === SLOT1.toISOString())).toBe(true);
    const mail = (await outboxFor(pool, u.clientA.email)).find((x) => x.payload.subject.startsWith("Meeting dijadwalkan"));
    expect(mail?.payload.paragraphs.join(" ")).toContain("09.00"); // jam lokal WIB di email
    expect(mail?.payload.paragraphs.join(" ")).toContain("https://meet.example.com/ruang-tiket");
  });

  it("meeting: slot yang sama untuk tiket lain ditolak dan tidak meninggalkan jejak parsial; batal membebaskan slot", async () => {
    const eventsBefore = (await getTicket(pool, staff(), t2)).events.length;
    expect(await code(scheduleTicketMeeting(pool, staff(), t2, { meetingTypeId, startsAt: SLOT1, now: NOW }, opts))).toBe("slot_unavailable");
    const after = await getTicket(pool, staff(), t2);
    expect(after.events.length).toBe(eventsBefore);
    expect(after.meetings).toHaveLength(0);

    const first = (await getTicket(pool, staff(), t1)).meetings[0]!;
    await cancelTicketMeeting(pool, staff(), t1, first.bookingId, opts);
    expect((await getMyTicket(pool, u.clientA.id, slug, t1)).meetings[0]!.status).toBe("cancelled");
    expect(await code(scheduleTicketMeeting(pool, staff(), t2, { meetingTypeId, startsAt: SLOT1, now: NOW }, opts))).toBe("ok");
    expect(await code(cancelTicketMeeting(pool, staff(), t1, first.bookingId, opts))).toBe("invalid_input"); // sudah batal
    expect(await code(cancelTicketMeeting(pool, staff(), t1, "00000000-0000-0000-0000-000000000000", opts))).toBe("not_found");
  });

  it("meeting serentak dari dua tiket ke slot yang sama: tepat satu berhasil", async () => {
    const a = await createTicket(pool, owner(), { clientId: (await listClients(pool, owner())).find((c) => c.userId === u.clientA.id)!.id, title: "Rebutan A" }, opts);
    const b = await createTicket(pool, owner(), { clientId: (await listClients(pool, owner())).find((c) => c.userId === u.clientB.id)!.id, title: "Rebutan B" }, opts);
    const r = await Promise.allSettled([a, b, a, b].map((t) => scheduleTicketMeeting(pool, staff(), t.number, { meetingTypeId, startsAt: SLOT2, now: NOW }, opts)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const f of r.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect((f.reason as AppError).code).toBe("slot_unavailable");
  });

  // ---------- Akhir hidup tiket ----------

  it("tiket ditutup: tidak menerima komentar, prioritas, lampiran, atau meeting; klien dapat email penutupan", async () => {
    await setTicketStatus(pool, staff(), t2, "closed", opts);
    expect((await getTicket(pool, staff(), t2)).ticket.closedAt).not.toBeNull();
    expect(await code(addStaffComment(pool, staff(), t2, { body: "x" }, opts))).toBe("invalid_input");
    expect(await code(addClientComment(pool, u.clientA.id, slug, t2, "x", opts))).toBe("invalid_input");
    expect(await code(setTicketPriority(pool, staff(), t2, "low"))).toBe("invalid_input");
    expect(await code(scheduleTicketMeeting(pool, staff(), t2, { meetingTypeId, startsAt: SLOT2, now: NOW }, opts))).toBe("invalid_input");
    expect(await code(setTicketStatus(pool, staff(), t2, "open", opts))).toBe("invalid_input"); // closed tak bisa dibuka staf
    expect((await outboxFor(pool, u.clientA.email)).some((m) => m.payload.subject.includes(`#${t2} ditutup`))).toBe(true);
  });

  it("klien menutup tiket sendiri dan membuka kembali yang sudah diselesaikan", async () => {
    await setTicketStatus(pool, staff(), t1, "resolved", opts);
    await setMyTicketStatus(pool, u.clientA.id, slug, t1, "open");
    expect((await getMyTicket(pool, u.clientA.id, slug, t1)).ticket.status).toBe("open");
    await setMyTicketStatus(pool, u.clientA.id, slug, t1, "closed");
    expect((await getMyTicket(pool, u.clientA.id, slug, t1)).events.map((e) => e.kind)).toContain("status");
  });

  it("klien diblokir: tidak bisa membuat tiket/komentar, tetap bisa membaca riwayatnya", async () => {
    const c = (await listClients(pool, owner())).find((x) => x.userId === u.clientB.id)!;
    expect(await code(setClientBlocked(pool, staff(), c.id, true))).toBe("forbidden"); // staf biasa tak boleh memblokir
    await setClientBlocked(pool, { userId: u.admin.id, slug }, c.id, true);
    expect(await code(createClientTicket(pool, u.clientB.id, slug, { title: "Setelah diblokir" }, opts))).toBe("forbidden");
    const mine = await listMyTickets(pool, u.clientB.id, slug);
    expect(mine.blocked).toBe(true);
    expect(mine.tickets.length).toBeGreaterThan(0);
    await setClientBlocked(pool, { userId: u.admin.id, slug }, c.id, false);
    expect(await code(createClientTicket(pool, u.clientB.id, slug, { title: "Setelah dibuka" }, opts))).toBe("ok");
  });

  it("staf membuat tiket atas nama klien (tanpa akun) dan klien tamu tidak muncul di portal siapa pun", async () => {
    const guest = await addClient(pool, owner(), { name: "Tamu Tanpa Akun", email: `tamu-${sfx}@x.local`, phone: "0812-5550-1234" });
    const t = await createTicket(pool, staff(), { clientId: guest.id, title: "Dibuat staf", priority: "urgent", assigneeMemberId: staffMemberId }, opts);
    const d = await getTicket(pool, staff(), t.number);
    expect(d.ticket.requesterUserId).toBeNull();
    expect(d.ticket.priority).toBe("urgent");
    expect(await code(createTicket(pool, staff(), { clientId: "00000000-0000-0000-0000-000000000000", title: "Tak ada klien" }, opts))).toBe("not_found");
    for (const k of ["clientA", "clientB"] as const) {
      expect((await listMyTickets(pool, u[k].id, slug)).tickets.map((x) => x.number)).not.toContain(t.number);
    }
  });

  // ---------- Isolasi di level SQL ----------

  describe("RLS mode klien (SQL mentah, tanpa lewat layanan)", () => {
    const asClient = <T>(userId: string, fn: (run: (q: ReturnType<typeof sql>) => Promise<Record<string, unknown>[]>) => Promise<T>) =>
      withTenant(pool, { userId, workspaceId: wsId, actor: "client" }, (db) => fn(async (q) => (await db.execute(q)).rows as Record<string, unknown>[]));
    const denied = (p: Promise<unknown>) => p.then(() => "ok", (e: { cause?: { message?: string }; message?: string }) => e.cause?.message ?? e.message ?? "error");

    it("hanya tiket, klien, dan workspace miliknya yang terlihat", async () => {
      await asClient(u.clientA.id, async (q) => {
        const tickets = await q(sql`SELECT number, requester_user_id FROM tickets`);
        expect(tickets.length).toBeGreaterThan(0);
        expect(tickets.every((t) => t.requester_user_id === u.clientA.id)).toBe(true);
        expect((await q(sql`SELECT user_id FROM workspace_clients`)).every((c) => c.user_id === u.clientA.id)).toBe(true);
        expect((await q(sql`SELECT name FROM workspaces`)).map((w) => w.name)).toEqual(["Praktik Tiket"]);
      });
    });

    it("tabel internal tertutup total: anggota, ketersediaan, outbox, kuota, undangan, audit", async () => {
      await asClient(u.clientA.id, async (q) => {
        for (const t of ["workspace_members", "notification_outbox", "notification_quota_usage", "workspace_invitations", "audit_log"]) {
          expect(await q(sql.raw(`SELECT * FROM ${t}`)), t).toHaveLength(0);
        }
        // ketersediaan boleh DIBACA klien (untuk memesan di portal) tetapi tidak ditulis
        expect((await q(sql`SELECT weekday FROM availability_rules`)).length).toBeGreaterThan(0);
        // pengguna lain (termasuk staf) tidak terlihat
        expect((await q(sql`SELECT email FROM users`)).map((r) => r.email)).toEqual([u.clientA.email]);
      });
    });

    it("tak bisa menulis atas nama orang lain, mengubah tiket orang lain, atau membuka blokir", async () => {
      const other = (await pool.query(`SELECT id FROM tickets WHERE workspace_id = $1 AND requester_user_id = $2 LIMIT 1`, [wsId, u.clientB.id])).rows[0].id;
      const mine = (await pool.query(`SELECT id FROM tickets WHERE workspace_id = $1 AND requester_user_id = $2 LIMIT 1`, [wsId, u.clientA.id])).rows[0].id;
      const anyClient = (await pool.query(`SELECT id FROM workspace_clients WHERE workspace_id = $1 LIMIT 1`, [wsId])).rows[0].id;
      const comment = (ticket: string, kind: string, internal: boolean) =>
        sql`INSERT INTO ticket_comments (workspace_id, ticket_id, author_user_id, author_kind, body, internal) VALUES (${wsId}, ${ticket}, ${u.clientA.id}, ${kind}, 'x', ${internal})`;
      // Penulisan yang harus MENGHASILKAN 0 baris (baris tak terlihat) atau DITOLAK RLS; tiap kasus di transaksinya sendiri.
      const zeroRows: [string, ReturnType<typeof sql>][] = [
        ["ubah tiket orang lain", sql`UPDATE tickets SET status = 'closed' WHERE id = ${other} RETURNING id`],
        ["hapus tiket orang lain", sql`DELETE FROM tickets WHERE id = ${other} RETURNING id`],
        ["buka blokir sendiri", sql`UPDATE workspace_clients SET blocked = false WHERE user_id = ${u.clientA.id} RETURNING id`],
        ["ubah workspace", sql`UPDATE workspaces SET name = 'diretas' RETURNING id`],
      ];
      for (const [label, q] of zeroRows) expect(await asClient(u.clientA.id, (run) => run(q)), label).toHaveLength(0);

      const rejected: [string, ReturnType<typeof sql>][] = [
        ["tiket atas nama orang lain", sql`INSERT INTO tickets (workspace_id, number, title, requester_user_id) VALUES (${wsId}, 99999, 'palsu', ${u.clientB.id})`],
        ["komentar di tiket orang lain", comment(other, "client", false)],
        ["komentar internal", comment(mine, "client", true)],
        ["menyamar sebagai staf", comment(mine, "staff", false)],
        ["menulis jam rutin", sql`INSERT INTO availability_rules (workspace_id, member_id, weekday, start_time, end_time) VALUES (${wsId}, ${staffMemberId}, 2, '00:00', '23:00')`],
        ["menulis outbox email", sql`INSERT INTO notification_outbox (workspace_id, channel, recipient, template) VALUES (${wsId}, 'email', 'korban@x.local', 'generic_notice')`],
        ["membuat booking", sql`INSERT INTO bookings (workspace_id, meeting_type_id, member_id, client_id, during, starts_at, ends_at, cancel_token_hash) VALUES (${wsId}, ${meetingTypeId}, ${staffMemberId}, ${anyClient}, '[2036-01-01,2036-01-02)', '2036-01-01', '2036-01-02', ${"x" + sfx})`],
      ];
      for (const [label, q] of rejected) {
        const msg = await denied(asClient(u.clientA.id, (run) => run(q)));
        expect(msg, label).toMatch(/row-level security/);
      }
    });

    it("klien tidak bisa menautkan booking ORANG LAIN ke tiketnya, atau menulis audit atas nama orang lain", async () => {
      const bookingOfA = (await pool.query(`SELECT b.id FROM bookings b JOIN workspace_clients c ON c.id = b.client_id WHERE b.workspace_id = $1 AND c.user_id = $2 LIMIT 1`, [wsId, u.clientA.id])).rows[0]?.id;
      expect(bookingOfA, "butuh booking milik klien A dari tes sebelumnya").toBeTruthy();
      const ownTicket = (await pool.query(`SELECT id FROM tickets WHERE workspace_id = $1 AND requester_user_id = $2 LIMIT 1`, [wsId, u.clientB.id])).rows[0].id;
      const linkOthers = await denied(asClient(u.clientB.id, (run) => run(sql`INSERT INTO ticket_meetings (workspace_id, ticket_id, booking_id) VALUES (${wsId}, ${ownTicket}, ${bookingOfA})`)));
      expect(linkOthers).toMatch(/row-level security/);
      const forged = await denied(asClient(u.clientB.id, (run) => run(sql`INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id) VALUES (${wsId}, ${u.owner.id}, 'palsu', 'x', 'x')`)));
      expect(forged).toMatch(/row-level security/);
      // atas nama sendiri tetap boleh (dipakai jalur sah)
      expect(await denied(asClient(u.clientB.id, (run) => run(sql`INSERT INTO audit_log (workspace_id, actor_user_id, action, entity_type, entity_id) VALUES (${wsId}, ${u.clientB.id}, 'sah', 'x', 'x')`)))).toBe("ok");
    });

    it("riwayat dan komentar tak bisa diubah/dihapus siapa pun lewat role aplikasi", async () => {
      expect(await denied(withTenant(pool, { userId: u.staff.id, workspaceId: wsId }, (db) => db.execute(sql`UPDATE ticket_comments SET body = 'diubah'`)))).toMatch(/permission denied/);
      expect(await denied(withTenant(pool, { userId: u.staff.id, workspaceId: wsId }, (db) => db.execute(sql`DELETE FROM ticket_events`)))).toMatch(/permission denied/);
    });

    it("antar-workspace: konteks workspace lain tidak melihat tiket ini sama sekali", async () => {
      const otherWs = (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [otherSlug])).rows[0].id;
      const rows = await withTenant(pool, { userId: u.outsider.id, workspaceId: otherWs }, (db) => db.execute(sql`SELECT * FROM tickets`));
      expect(rows.rows).toHaveLength(0);
      expect(await code(getTicket(pool, { userId: u.outsider.id, slug: otherSlug }, t1))).toBe("not_found");
      expect(await code(getTicket(pool, { userId: u.outsider.id, slug }, t1))).toBe("not_found");
    });
  });

  it("riwayat sebuah tiket yang melalui seluruh siklus hidup lengkap dan berurutan", async () => {
    const d = await getTicket(pool, staff(), t1);
    const kinds = d.events.map((e) => e.kind);
    for (const k of ["created", "assign", "status", "priority", "meeting"]) expect(kinds).toContain(k);
    const times = d.events.map((e) => e.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
