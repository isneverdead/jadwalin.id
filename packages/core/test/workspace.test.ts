import { createPool, withTenant } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addClient, AppError, createWorkspace, deleteWorkspace, getPublicWorkspace, inviteMember, listMembers, listMyClientWorkspaces, listMyWorkspaces, removeMember, withWorkspace } from "../src";
import { inviteAndAccept } from "./helpers";

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);

describe.skipIf(!url)("workspace, anggota, klien (Postgres asli)", () => {
  let pool: pg.Pool;
  const u = {} as Record<"owner" | "admin" | "staff" | "outsider" | "client", string>;
  let slugA: string;
  let slugB: string;

  async function mkUser(key: keyof typeof u) {
    const email = `${key}-${sfx}@test.local`;
    const r = await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [email, key]);
    u[key] = r.rows[0].id;
    return email;
  }
  const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    for (const k of ["owner", "admin", "staff", "outsider", "client"] as const) await mkUser(k);
    slugA = `toko-a-${sfx}`;
    slugB = `toko-b-${sfx}`;
    await createWorkspace(pool, u.owner, { name: "Toko A", slug: slugA });
    await createWorkspace(pool, u.outsider, { name: "Toko B", slug: slugB });
  });
  afterAll(async () => pool?.end());

  const email = (k: string) => `${k}-${sfx}@test.local`;
  const owner = () => ({ userId: u.owner, slug: slugA });

  it("slug: validasi, reserved, dan duplikat", async () => {
    expect(await code(createWorkspace(pool, u.owner, { name: "X", slug: "ab" }))).toBe("invalid_input");
    expect(await code(createWorkspace(pool, u.owner, { name: "Xx", slug: "ab" }))).toBe("invalid_slug");
    expect(await code(createWorkspace(pool, u.owner, { name: "Xx", slug: "admin" }))).toBe("invalid_slug");
    expect(await code(createWorkspace(pool, u.owner, { name: "Xx", slug: "Bad_Slug" }))).toBe("invalid_slug");
    expect(await code(createWorkspace(pool, u.outsider, { name: "Dup", slug: slugA }))).toBe("slug_taken");
  });

  it("daftar workspace hanya milik saya", async () => {
    expect((await listMyWorkspaces(pool, u.owner)).map((w) => w.slug)).toEqual([slugA]);
    expect((await listMyWorkspaces(pool, u.outsider)).map((w) => w.slug)).toEqual([slugB]);
  });

  it("bukan anggota → not_found, tanpa membocorkan keberadaan workspace", async () => {
    expect(await code(listMembers(pool, { userId: u.outsider, slug: slugA }))).toBe("not_found");
    expect(await code(listMembers(pool, { userId: u.owner, slug: "tidak-ada" }))).toBe("not_found");
  });

  it("owner mengundang admin dan staf lewat email; sudah anggota ditolak", async () => {
    await inviteAndAccept(pool, owner(), { userId: u.admin, email: email("admin"), role: "admin" });
    await inviteAndAccept(pool, owner(), { userId: u.staff, email: email("staff"), role: "staff" });
    expect(await code(inviteMember(pool, owner(), { email: email("staff"), role: "staff" }, { baseUrl: "http://t" }))).toBe("already_member");
    const members = await listMembers(pool, owner());
    expect(members.map((m) => m.role).sort()).toEqual(["admin", "owner", "staff"]);
  });

  it("anggota yang punya workspace lain tidak muncul ganda atau membawa keanggotaan workspace lain", async () => {
    const other = await createWorkspace(pool, u.owner, { name: "Ruang kedua", slug: `dua-${sfx}` });
    const members = await listMembers(pool, owner());
    expect(members.filter((m) => m.userId === u.owner)).toHaveLength(1);
    expect(members.map((m) => m.id)).not.toContain((await pool.query(`SELECT id FROM workspace_members WHERE workspace_id = $1`, [other.id])).rows[0].id);
  });

  it("izin peran: staf tak bisa mengundang, admin tak bisa mengundang admin", async () => {
    const asStaff = { userId: u.staff, slug: slugA };
    const asAdmin = { userId: u.admin, slug: slugA };
    expect(await code(inviteMember(pool, asStaff, { email: email("client"), role: "staff" }, { baseUrl: "http://t" }))).toBe("forbidden");
    expect(await code(inviteMember(pool, asAdmin, { email: email("client"), role: "admin" }, { baseUrl: "http://t" }))).toBe("forbidden");
    expect(await code(listMembers(pool, asStaff))).toBe("ok");
  });

  it("owner tak bisa dikeluarkan; admin tak bisa mengeluarkan admin; anggota hilang akses", async () => {
    const members = await listMembers(pool, owner());
    const idOf = (r: string) => members.find((m) => m.role === r)!.id;
    const asAdmin = { userId: u.admin, slug: slugA };
    expect(await code(removeMember(pool, asAdmin, idOf("owner")))).toBe("forbidden");
    expect(await code(removeMember(pool, asAdmin, idOf("admin")))).toBe("forbidden");
    await removeMember(pool, asAdmin, idOf("staff"));
    expect(await code(listMembers(pool, { userId: u.staff, slug: slugA }))).toBe("not_found");
  });

  it("klien: tercatat di workspace dan muncul di 'Jadwal saya' hanya untuk dirinya", async () => {
    await addClient(pool, owner(), { name: "Klien Satu", email: "Klien@Test.Local", phone: "0812-3456-7890", userId: u.client });
    const mine = await listMyClientWorkspaces(pool, u.client);
    expect(mine.map((w) => w.slug)).toEqual([slugA]);
    expect(await listMyClientWorkspaces(pool, u.outsider)).toEqual([]);
    const row = await pool.query(`SELECT email, phone FROM workspace_clients WHERE user_id = $1`, [u.client]);
    expect(row.rows[0]).toEqual({ email: "klien@test.local", phone: "6281234567890" });
  });

  it("klien bukan anggota: tidak bisa membuka workspace sebagai staf", async () => {
    expect(await code(listMembers(pool, { userId: u.client, slug: slugA }))).toBe("not_found");
  });

  it("audit log mencatat perubahan keanggotaan", async () => {
    const r = await pool.query(`SELECT action FROM audit_log WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = $1) ORDER BY created_at`, [slugA]);
    const actions = r.rows.map((x) => x.action);
    expect(actions).toContain("workspace.created");
    expect(actions).toContain("invitation.created");
    expect(actions).toContain("invitation.accepted");
    expect(actions).toContain("member.removed");
    expect(actions).toContain("client.added");
  });

  it("konteks palsu: workspace id dipaksa tidak membuka data workspace lain, dan role app tak bisa baca tabel auth", async () => {
    const wsA = (await pool.query(`SELECT id FROM workspaces WHERE slug = $1`, [slugA])).rows[0].id;
    // outsider memaksa konteks workspace A lewat jalur withTenant langsung: RLS hanya cek workspace_id,
    // maka otorisasi wajib lewat withWorkspace (di atas). Tes ini mengunci bahwa jalur itu menolak.
    expect(await code(withWorkspace(pool, { userId: u.outsider, slug: slugA }, "staff", async () => 1))).toBe("not_found");
    await expect(withTenant(pool, { userId: u.outsider, workspaceId: wsA }, (db) => db.execute(sql`SELECT * FROM sessions`))).rejects.toThrow();
    // user tanpa konteks workspace tidak melihat anggota workspace A
    const none = await withTenant(pool, { userId: u.outsider }, (db) => db.execute(sql`SELECT * FROM workspace_members WHERE workspace_id = ${wsA}`));
    expect(none.rows).toHaveLength(0);
    expect(randomUUID()).toBeTruthy();
  });

  it("hapus halaman: hanya pemilik + konfirmasi nama; hilang dari semua akses, slug dibebaskan, audit tercatat", async () => {
    const slug = `hapus-${sfx}`;
    await createWorkspace(pool, u.owner, { name: "Toko Hapus", slug });
    await inviteAndAccept(pool, { userId: u.owner, slug }, { userId: u.admin, email: email("admin"), role: "admin" });
    expect(await code(deleteWorkspace(pool, { userId: u.admin, slug }, "Toko Hapus"))).toBe("forbidden");
    expect(await code(deleteWorkspace(pool, { userId: u.outsider, slug }, "Toko Hapus"))).toBe("not_found");
    expect(await code(deleteWorkspace(pool, { userId: u.owner, slug }, "salah"))).toBe("invalid_input");
    expect((await getPublicWorkspace(pool, slug))?.name).toBe("Toko Hapus");

    await deleteWorkspace(pool, { userId: u.owner, slug }, " Toko Hapus ");
    expect(await getPublicWorkspace(pool, slug)).toBeNull();
    expect((await listMyWorkspaces(pool, u.owner)).some((w) => w.slug === slug)).toBe(false);
    expect(await code(withWorkspace(pool, { userId: u.owner, slug }, "owner", async () => 1))).toBe("not_found");
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'workspace.deleted' AND diff->>'slug' = $1`, [slug]);
    expect(audit.rows[0].n).toBe(1);
    await createWorkspace(pool, u.owner, { name: "Pakai Ulang", slug }); // slug bebas lagi
  });
});
