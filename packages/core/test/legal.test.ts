import { randomUUID } from "node:crypto";
import { createPool, schema } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, exportMyData, listAuditLog, listMyDataRequests, requestAccountDeletion } from "../src";

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("hak data dan log audit (Postgres asli)", () => {
  let pool: pg.Pool;
  const sfx = randomUUID().slice(0, 8);
  const mk = async (tag: string) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [id, tag, `${tag}-${sfx}@legal.local`]);
    return id;
  };
  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
  });
  afterAll(async () => pool.end());

  it("ekspor hanya berisi data pengguna sendiri", async () => {
    const a = await mk("ea");
    const b = await mk("eb");
    await createWorkspace(pool, a, { name: "Ruang A", slug: `legal-a-${sfx}` });
    const dumpB = await exportMyData(pool, b);
    expect(dumpB.user?.email).toBe(`eb-${sfx}@legal.local`);
    expect(dumpB.memberships).toHaveLength(0);
    const dumpA = await exportMyData(pool, a);
    expect(dumpA.memberships.map((m) => m.slug)).toEqual([`legal-a-${sfx}`]);
    expect(JSON.stringify(dumpA)).not.toContain("password");
  });

  it("permintaan hapus: tercatat, idempoten (satu tertunda), terisolasi antar-pengguna, tak bisa diubah pemohon", async () => {
    const a = await mk("da");
    const b = await mk("db");
    await requestAccountDeletion(pool, a);
    await requestAccountDeletion(pool, a);
    expect(await listMyDataRequests(pool, a)).toHaveLength(1);
    expect(await listMyDataRequests(pool, b)).toHaveLength(0);
    const { withTenant } = await import("@jadwalin/db");
    await expect(withTenant(pool, { userId: a }, (db) => db.update(schema.dataRequests).set({ status: "done" }))).rejects.toThrow();
    await expect(withTenant(pool, { userId: b }, (db) => db.insert(schema.dataRequests).values({ userId: a, kind: "delete" }))).rejects.toThrow();
  });

  it("log audit: admin/owner saja, terbatas pada workspace sendiri", async () => {
    const owner = await mk("ao");
    const staff = await mk("as");
    const other = await mk("ax");
    await createWorkspace(pool, owner, { name: "Audit", slug: `legal-audit-${sfx}` });
    await createWorkspace(pool, other, { name: "Lain", slug: `legal-lain-${sfx}` });
    const rows = await listAuditLog(pool, { userId: owner, slug: `legal-audit-${sfx}` });
    expect(rows.some((r) => r.action === "workspace.created")).toBe(true);
    await expect(listAuditLog(pool, { userId: other, slug: `legal-audit-${sfx}` })).rejects.toMatchObject({ code: "not_found" });
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, $1, 'staff' FROM workspaces WHERE slug = $2`, [staff, `legal-audit-${sfx}`]).catch(() => undefined);
    await expect(listAuditLog(pool, { userId: staff, slug: `legal-audit-${sfx}` })).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
  });
});
