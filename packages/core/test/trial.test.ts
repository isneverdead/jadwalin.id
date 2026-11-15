import { randomUUID } from "node:crypto";
import { createPool } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRIAL_DAYS, createWorkspace, getPublicWorkspace, listMyWorkspaces, trialState } from "../src";

describe("trialState (murni)", () => {
  const now = new Date("2030-01-10T00:00:00Z");
  it("bukan masa uji untuk paket berbayar atau gratis tanpa batas", () => {
    expect(trialState("studio", new Date("2030-02-01T00:00:00Z"), now).onTrial).toBe(false);
    expect(trialState("gratis", null, now)).toEqual({ onTrial: false, expired: false, daysLeft: null });
  });
  it("menghitung sisa hari (dibulatkan ke atas) dan habis tepat pada batas", () => {
    expect(trialState("gratis", new Date("2030-01-10T12:00:00Z"), now)).toEqual({ onTrial: true, expired: false, daysLeft: 1 });
    expect(trialState("gratis", new Date("2030-01-17T00:00:00Z"), now).daysLeft).toBe(7);
    expect(trialState("gratis", now, now)).toEqual({ onTrial: true, expired: true, daysLeft: 0 });
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("masa uji 14 hari: halaman publik tutup setelah habis", () => {
  let pool: pg.Pool;
  const sfx = randomUUID().slice(0, 8);
  let uid: string;
  const slug = `trial-${sfx}`;

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    uid = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'Trial', true) RETURNING id`, [`trial-${sfx}@trial.local`])).rows[0].id;
    await createWorkspace(pool, uid, { name: "Usaha Trial", slug });
  });
  afterAll(async () => { await pool.end(); });

  it("usaha baru mendapat masa uji 14 hari dan halaman publiknya terbuka", async () => {
    const [w] = (await listMyWorkspaces(pool, uid)).filter((x) => x.slug === slug);
    const days = (w!.planUntil!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(TRIAL_DAYS - 0.1);
    expect(days).toBeLessThanOrEqual(TRIAL_DAYS);
    expect(await getPublicWorkspace(pool, slug)).not.toBeNull();
  });

  it("setelah masa uji habis halaman publik tidak ditemukan; paket berbayar atau tanpa batas tetap terbuka", async () => {
    await pool.query(`UPDATE workspaces SET plan_until = now() - interval '1 minute' WHERE slug = $1`, [slug]);
    expect(await getPublicWorkspace(pool, slug)).toBeNull();
    await pool.query(`UPDATE workspaces SET plan = 'studio', plan_until = now() + interval '30 days' WHERE slug = $1`, [slug]);
    expect(await getPublicWorkspace(pool, slug)).not.toBeNull();
    await pool.query(`UPDATE workspaces SET plan = 'gratis', plan_until = NULL WHERE slug = $1`, [slug]);
    expect(await getPublicWorkspace(pool, slug)).not.toBeNull();
  });
});
