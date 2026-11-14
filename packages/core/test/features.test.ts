import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AppError,
  applyBusinessTemplate,
  BUSINESS_TEMPLATES,
  createMeetingType,
  createWorkspace,
  DEFAULT_FEATURES,
  featuresFromInput,
  getFeatures,
  getPublicOverview,
  listAuditLog,
  listPublicSlots,
  listMeetingTypes,
  listMyWorkspaces,
  parseFeatures,
  requestUpload,
  setFeatures,
  setMeetingTypeActive,
  updateMeetingType,
  type StorageAdapter,
} from "../src";
import { inviteAndAccept } from "./helpers";

describe("fitur usaha (murni)", () => {
  it("kunci hilang/ngawur → aktif (usaha lama tidak berubah)", () => {
    expect(parseFeatures(undefined)).toEqual(DEFAULT_FEATURES);
    expect(parseFeatures({ tiket: "tidak", pembayaran: false })).toEqual({ jadwal: true, tiket: true, pembayaran: false, berkas: true, sewa: false });
  });
  it("input form: hanya yang dicentang yang menyala", () => {
    expect(featuresFromInput({ jadwal: "on", tiket: "on" })).toEqual({ jadwal: true, tiket: true, pembayaran: false, berkas: false, sewa: false });
  });
  it("setiap template punya saran fitur dan alasan", () => {
    for (const t of BUSINESS_TEMPLATES) {
      expect(t.featureWhy.length, t.id).toBeGreaterThan(10);
      // Template tanpa fitur pembayaran tidak boleh membawa layanan ber-DP yang akan ditolak.
      if (!t.features.pembayaran) expect(t.meetingTypes.every((m) => !m.depositIdr || m.depositIdr >= 0)).toBe(true);
    }
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("fitur usaha (Postgres asli)", () => {
  let pool: pg.Pool;
  const sfx = Math.random().toString(36).slice(2, 8);
  let owner: { userId: string; slug: string };
  let staffId = "";
  let staffEmail = "";
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));
  const stubStorage = {} as StorageAdapter; // fitur dicek sebelum penyimpanan disentuh

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    const mk = async (k: string) => (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [`${k}-${sfx}@ft.local`, k])).rows[0].id as string;
    const ownerId = await mk("owner");
    staffId = await mk("staff");
    staffEmail = `staff-${sfx}@ft.local`;
    await createWorkspace(pool, ownerId, { name: "Fitur Uji", slug: `ft-${sfx}` });
    owner = { userId: ownerId, slug: `ft-${sfx}` };
    await inviteAndAccept(pool, owner, { userId: staffId, email: staffEmail, role: "staff" });
  });
  afterAll(async () => pool?.end());

  it("usaha baru: semua aktif bila tidak ditentukan; terlihat di daftar usaha dan halaman publik", async () => {
    expect(await getFeatures(pool, owner)).toEqual(DEFAULT_FEATURES);
    const mine = (await listMyWorkspaces(pool, owner.userId)).find((w) => w.slug === owner.slug)!;
    expect(mine.features).toEqual(DEFAULT_FEATURES);
    await createMeetingType(pool, owner, { slug: "umum", title: "Umum", durationMin: 30, locationKind: "link" });
    expect((await getPublicOverview(pool, owner.slug))?.workspace.features).toEqual(DEFAULT_FEATURES);
  });

  it("hanya admin/pemilik yang boleh mengubah; perubahan tercatat di audit", async () => {
    expect(await code(setFeatures(pool, { userId: staffId, slug: owner.slug }, { jadwal: true, tiket: false, pembayaran: true, berkas: true, sewa: false }))).toBe("forbidden");
    const next = await setFeatures(pool, owner, { jadwal: true, tiket: false, pembayaran: true, berkas: true, sewa: false });
    expect(next.tiket).toBe(false);
    expect((await getFeatures(pool, owner)).tiket).toBe(false);
    const log = await listAuditLog(pool, owner, { limit: 20 });
    expect(log.some((r) => r.action === "workspace.features_updated")).toBe(true);
    await setFeatures(pool, owner, DEFAULT_FEATURES);
  });

  it("berkas dimatikan → permintaan unggah ditolak di server", async () => {
    await setFeatures(pool, owner, { ...DEFAULT_FEATURES, berkas: false, sewa: false });
    expect(await code(requestUpload(pool, owner, stubStorage, { filename: "a.pdf", mime: "application/pdf", sizeBytes: 100 }))).toBe("feature_disabled");
    await setFeatures(pool, owner, DEFAULT_FEATURES);
  });

  it("pembayaran: tidak bisa mematikan selagi ada layanan aktif ber-DP; DP tidak bisa dibuat saat mati", async () => {
    const t = await createMeetingType(pool, owner, { slug: "berbayar", title: "Berbayar", durationMin: 60, locationKind: "link", depositIdr: 50000 });
    expect(await code(setFeatures(pool, owner, { ...DEFAULT_FEATURES, pembayaran: false }))).toBe("invalid_input");
    await setMeetingTypeActive(pool, owner, t.id, false);
    await setFeatures(pool, owner, { ...DEFAULT_FEATURES, pembayaran: false });
    expect(await code(createMeetingType(pool, owner, { slug: "dp-lagi", title: "DP lagi", durationMin: 30, locationKind: "link", depositIdr: 20000 }))).toBe("feature_disabled");
    expect(await code(createMeetingType(pool, owner, { slug: "gratis-ok", title: "Gratis OK", durationMin: 30, locationKind: "link" }))).toBe("ok");
    await setFeatures(pool, owner, DEFAULT_FEATURES);
  });

  it("template: layanan ber-DP dibuat gratis bila pembayaran dimatikan saat membuat usaha", async () => {
    const slug = `ft2-${sfx}`;
    await createWorkspace(pool, owner.userId, { name: "Salon Tanpa DP", slug, features: { jadwal: true, tiket: false, pembayaran: false, berkas: false, sewa: false } });
    const actor = { userId: owner.userId, slug };
    await applyBusinessTemplate(pool, actor, "salon", { jadwal: true, tiket: false, pembayaran: false, berkas: false, sewa: false });
    const types = await listMeetingTypes(pool, actor);
    expect(types.length).toBe(3);
    expect(types.every((x) => x.depositIdr === 0)).toBe(true);
    expect(await getFeatures(pool, actor)).toEqual({ jadwal: true, tiket: false, pembayaran: false, berkas: false, sewa: false });
  });

  it("ubah layanan: nama/durasi/DP berubah, DP ditolak saat pembayaran mati, staf tidak boleh", async () => {
    const slug = `ft3-${sfx}`;
    await createWorkspace(pool, owner.userId, { name: "Ubah Layanan", slug, features: { ...DEFAULT_FEATURES, pembayaran: false } });
    const actor = { userId: owner.userId, slug };
    const t = await createMeetingType(pool, actor, { slug: "sesi", title: "Sesi", durationMin: 30, locationKind: "link" });
    await updateMeetingType(pool, actor, t.id, { title: "Sesi Baru", durationMin: 45, locationKind: "in_person", locationValue: "Jl. Mawar 1" });
    const row = (await listMeetingTypes(pool, actor)).find((x) => x.id === t.id)!;
    expect(row).toMatchObject({ title: "Sesi Baru", durationMin: 45, locationKind: "in_person", locationValue: "Jl. Mawar 1", slug: "sesi" });
    expect(await code(updateMeetingType(pool, actor, t.id, { title: "Sesi Baru", durationMin: 45, depositIdr: 50000, locationKind: "link" }))).toBe("feature_disabled");
    await setFeatures(pool, actor, DEFAULT_FEATURES);
    await updateMeetingType(pool, actor, t.id, { title: "Sesi Baru", durationMin: 45, depositIdr: 50000, locationKind: "link" });
    expect((await listMeetingTypes(pool, actor)).find((x) => x.id === t.id)!.depositIdr).toBe(50000);
    expect(await code(updateMeetingType(pool, actor, t.id, { title: "x", durationMin: 45, locationKind: "link" }))).toBe("invalid_input");
    expect(await code(updateMeetingType(pool, actor, "00000000-0000-0000-0000-000000000000", { title: "Sesi", durationMin: 45, locationKind: "link" }))).toBe("not_found");
    await inviteAndAccept(pool, actor, { userId: staffId, email: staffEmail, role: "staff" });
    expect(await code(updateMeetingType(pool, { userId: staffId, slug }, t.id, { title: "Sesi", durationMin: 45, locationKind: "link" }))).toBe("forbidden");
  });

  it("janji temu per jam (jadwal) bisa dimatikan untuk usaha sewa-saja: halaman publik kosong, tidak bisa membuat layanan, minimal satu mode harus aktif", async () => {
    const slug = `ft-sewa-${sfx}`;
    await createWorkspace(pool, owner.userId, { name: "Sewa Saja", slug, features: { ...DEFAULT_FEATURES, sewa: true } });
    const o = { userId: owner.userId, slug };
    await createMeetingType(pool, o, { slug: "tes", title: "Tes", durationMin: 30, locationKind: "link" });
    expect((await getPublicOverview(pool, slug))?.types).toHaveLength(1); // jadwal aktif: layanan tampil
    // Dua-duanya mati ditolak.
    expect(await code(setFeatures(pool, o, { ...DEFAULT_FEATURES, jadwal: false, sewa: false }))).toBe("invalid_input");
    await setFeatures(pool, o, { ...DEFAULT_FEATURES, jadwal: false, sewa: true });
    expect(await code(createMeetingType(pool, o, { slug: "baru", title: "Baru", durationMin: 30, locationKind: "link" }))).toBe("feature_disabled");
    expect((await getPublicOverview(pool, slug))?.types).toEqual([]);
    expect(await listPublicSlots(pool, slug, "tes")).toBeNull();
  });
});
