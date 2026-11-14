import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBusinessSetup, applyBusinessTemplate, AppError, BUSINESS_TEMPLATES, defaultStep, slugifyTitle, createWorkspace, getBusinessTemplate, getWeeklyAvailability, listMeetingTypes, validateRules } from "../src";

describe("template bisnis (data)", () => {
  it("minimal 30 template dengan id unik dan isi valid", () => {
    expect(BUSINESS_TEMPLATES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(BUSINESS_TEMPLATES.map((t) => t.id)).size).toBe(BUSINESS_TEMPLATES.length);
    for (const t of BUSINESS_TEMPLATES) {
      expect(() => validateRules(t.availability), t.id).not.toThrow();
      if (t.kind === "sewa") {
        expect(t.products.length, t.id).toBeGreaterThan(0);
        expect(t.features.sewa, t.id).toBe(true);
        for (const p of t.products) {
          expect(Number.isInteger(p.pricePerDayIdr) && p.pricePerDayIdr >= 0, `${t.id}/${p.name}`).toBe(true);
          expect(p.units, `${t.id}/${p.name}`).toBeGreaterThanOrEqual(1);
          expect(p.units, `${t.id}/${p.name}`).toBeLessThanOrEqual(50);
        }
      } else {
        expect(t.meetingTypes.length, t.id).toBeGreaterThan(0);
      }
      expect(t.meetingTypes.length, t.id).toBeLessThanOrEqual(3); // batas paket Gratis
      expect(new Set(t.meetingTypes.map((m) => m.slug)).size, t.id).toBe(t.meetingTypes.length);
      for (const m of t.meetingTypes) {
        expect(m.slug, `${t.id}/${m.slug}`).toMatch(/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/);
        expect(Number.isInteger(m.depositIdr) && (m.depositIdr === 0 || m.depositIdr! >= 1000), `${t.id}/${m.slug}`).toBe(true);
      }
      expect(t.nextSteps.length, t.id).toBeGreaterThan(0);
    }
  });
  it("id tak dikenal ditolak", () => {
    expect(() => getBusinessTemplate("tidak-ada")).toThrow(AppError);
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("terapkan template (Postgres asli)", () => {
  let pool: pg.Pool;
  const sfx = Math.random().toString(36).slice(2, 8);
  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
  });
  afterAll(async () => pool?.end());

  it("semua template benar-benar bisa diterapkan (lolos validasi core)", async () => {
    // Satu akun maksimal 5 usaha: pakai akun baru tiap 4 template.
    let userId = "";
    let n = 0;
    for (const t of BUSINESS_TEMPLATES) {
      if (n % 4 === 0) userId = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'T', true) RETURNING id`, [`tpl-${n}-${sfx}@test.local`])).rows[0].id;
      const slug = `tpl-${t.id}-${sfx}`.slice(0, 32);
      await createWorkspace(pool, userId, { name: t.name, slug });
      const actor = { userId, slug };
      const r = await applyBusinessTemplate(pool, actor, t.id);
      expect(r.meetingTypes, t.id).toBe(t.meetingTypes.length);
      expect((await listMeetingTypes(pool, actor)).length, t.id).toBe(t.meetingTypes.length);
      expect((await getWeeklyAvailability(pool, actor)).length, t.id).toBe(t.availability.length);
      n++;
    }
  }, 120_000);

  it("rancangan yang disesuaikan pemilik: nama kembar diberi akhiran, DP dipaksa 0 tanpa pembayaran, jam kerja dipakai apa adanya", async () => {
    const userId = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'C', true) RETURNING id`, [`custom-${sfx}@test.local`])).rows[0].id as string;
    const slug = `cst-${sfx}`;
    await createWorkspace(pool, userId, { name: "Kustom", slug });
    const actor = { userId, slug };
    const r = await applyBusinessSetup(pool, actor, {
      availability: [{ weekday: 1, start: "08:00", end: "12:00" }, { weekday: 1, start: "16:00", end: "20:00" }, { weekday: 6, start: "10:00", end: "14:00" }],
      services: [
        { title: "Sesi Spesial (Baru!)", durationMin: 45, depositIdr: 75000, locationKind: "in_person" },
        { title: "Sesi Spesial (Baru!)", durationMin: 90, depositIdr: 0, locationKind: "link" },
      ],
    }, { jadwal: true, tiket: false, pembayaran: false, berkas: true, sewa: false });
    expect(r.meetingTypes).toBe(2);
    const types = await listMeetingTypes(pool, actor);
    expect(types.map((t) => t.slug).sort()).toEqual(["sesi-spesial-baru", "sesi-spesial-baru-2"]);
    expect(types.every((t) => t.depositIdr === 0)).toBe(true); // pembayaran mati → DP dipaksa 0
    expect(types.find((t) => t.slug === "sesi-spesial-baru")).toMatchObject({ durationMin: 45, slotStepMin: 45, locationKind: "in_person" });
    expect((await getWeeklyAvailability(pool, actor)).length).toBe(3);
  });

  it("rancangan tidak valid ditolak oleh validasi core", async () => {
    const userId = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'D', true) RETURNING id`, [`custom2-${sfx}@test.local`])).rows[0].id as string;
    const slug = `cst2-${sfx}`;
    await createWorkspace(pool, userId, { name: "Kustom 2", slug });
    const actor = { userId, slug };
    const bad = (setup: Parameters<typeof applyBusinessSetup>[2]) => applyBusinessSetup(pool, actor, setup, { jadwal: true, tiket: true, pembayaran: true, berkas: true, sewa: false }).then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));
    expect(await bad({ availability: [{ weekday: 1, start: "17:00", end: "09:00" }], services: [] })).toBe("invalid_input");
    expect(await bad({ availability: [], services: [{ title: "x", durationMin: 30, locationKind: "link" }] })).toBe("invalid_input"); // nama terlalu pendek
    expect(await bad({ availability: [], services: Array.from({ length: 11 }, (_, i) => ({ title: `Layanan ${i}`, durationMin: 30, locationKind: "link" as const })) })).toBe("invalid_input");
    expect(await bad({ availability: [], services: [{ title: "DP kecil", durationMin: 30, depositIdr: 500, locationKind: "link" }] })).toBe("invalid_input");
  });
});

describe("pembantu rancangan (murni)", () => {
  it("slugifyTitle: aksen, simbol, kembar", () => {
    expect(slugifyTitle("Konsultasi Awal (Gratis)")).toBe("konsultasi-awal-gratis");
    expect(slugifyTitle("Pijat Refleksi — Spesial!")).toBe("pijat-refleksi-spesial");
    expect(slugifyTitle("???")).toBe("layanan");
    expect(slugifyTitle("A", new Set())).toBe("a-1");
    expect(slugifyTitle("Sesi", new Set(["sesi", "sesi-2"]))).toBe("sesi-3");
    expect(slugifyTitle("x".repeat(80)).length).toBeLessThanOrEqual(40);
  });
  it("defaultStep: durasi pendek = durasinya, panjang menyesuaikan", () => {
    expect([defaultStep(20), defaultStep(45), defaultStep(60), defaultStep(90), defaultStep(120), defaultStep(NaN)]).toEqual([20, 45, 60, 30, 60, 30]);
  });
});
