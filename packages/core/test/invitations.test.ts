import { createPool, withTenant } from "@jadwalin/db";
import { migrateUp } from "@jadwalin/db/migrate";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvitation, AppError, createWorkspace, hashToken, inviteMember, listInvitations, listMembers, previewInvitation, revokeInvitation } from "../src";
import { tokenFromOutbox } from "./helpers";

const url = process.env.DATABASE_URL;
const sfx = Math.random().toString(36).slice(2, 8);
const base = { baseUrl: "http://t.local" };

describe.skipIf(!url)("undangan anggota (Postgres asli)", () => {
  let pool: pg.Pool;
  const u = {} as Record<"owner" | "admin" | "staff" | "invitee" | "wrong" | "unverified" | "outsider", string>;
  let slug: string;
  const email = (k: string) => `${k}-${sfx}@inv.local`;
  const owner = () => ({ userId: u.owner, slug });
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `other:${e}`));

  beforeAll(async () => {
    await migrateUp(url!);
    pool = createPool(url!);
    for (const k of ["owner", "admin", "staff", "invitee", "wrong", "outsider"] as const) {
      u[k] = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, $2, true) RETURNING id`, [email(k), k])).rows[0].id;
    }
    u.unverified = (await pool.query(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'unverified', false) RETURNING id`, [email("unverified")])).rows[0].id;
    slug = `undangan-${sfx}`;
    await createWorkspace(pool, u.owner, { name: "Undangan", slug });
    const admin = await inviteMember(pool, owner(), { email: email("admin"), role: "admin" }, base);
    void admin;
    await acceptInvitation(pool, u.admin, await tokenFromOutbox(pool, email("admin")));
    await acceptInvitation(pool, u.staff, await (async () => {
      await inviteMember(pool, owner(), { email: email("staff"), role: "staff" }, base);
      return tokenFromOutbox(pool, email("staff"));
    })());
  });
  afterAll(async () => pool?.end());

  it("token hanya ada di email: DB menyimpan hash saja", async () => {
    await inviteMember(pool, owner(), { email: email("invitee"), role: "staff" }, base);
    const token = await tokenFromOutbox(pool, email("invitee"));
    expect(token.length).toBeGreaterThanOrEqual(40);
    const row = (await pool.query(`SELECT token_hash FROM workspace_invitations WHERE lower(email) = $1`, [email("invitee")])).rows[0];
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toContain(token);
    const all = await pool.query(`SELECT count(*)::int AS n FROM workspace_invitations WHERE token_hash = $1`, [token]);
    expect(all.rows[0].n).toBe(0);
  });

  it("mengundang email yang belum terdaftar bekerja sama persis (tidak membocorkan akun)", async () => {
    expect(await code(inviteMember(pool, owner(), { email: `belum-ada-${sfx}@inv.local`, role: "staff" }, base))).toBe("ok");
    expect(await code(inviteMember(pool, owner(), { email: "bukan-email", role: "staff" }, base))).toBe("invalid_input");
  });

  it("undangan ganda aktif ditolak; sudah anggota ditolak", async () => {
    expect(await code(inviteMember(pool, owner(), { email: email("invitee"), role: "staff" }, base))).toBe("invitation_exists");
    expect(await code(inviteMember(pool, owner(), { email: email("staff").toUpperCase(), role: "staff" }, base))).toBe("already_member");
  });

  it("izin: staf tidak bisa mengundang; admin hanya bisa mengundang staf", async () => {
    expect(await code(inviteMember(pool, { userId: u.staff, slug }, { email: email("x1"), role: "staff" }, base))).toBe("forbidden");
    expect(await code(inviteMember(pool, { userId: u.admin, slug }, { email: email("x2"), role: "admin" }, base))).toBe("forbidden");
    expect(await code(inviteMember(pool, { userId: u.admin, slug }, { email: email("x3"), role: "staff" }, base))).toBe("ok");
    expect(await code(inviteMember(pool, { userId: u.outsider, slug }, { email: email("x4"), role: "staff" }, base))).toBe("not_found");
  });

  it("pratinjau: hanya pemegang token; token acak tidak menghasilkan apa-apa", async () => {
    const token = await tokenFromOutbox(pool, email("invitee"));
    const ok = await previewInvitation(pool, u.invitee, token);
    expect(ok).toMatchObject({ workspaceName: "Undangan", role: "staff", canAccept: true });
    expect(await previewInvitation(pool, u.invitee, "token-acak-yang-salah")).toBeNull();
    const wrong = await previewInvitation(pool, u.wrong, token);
    expect(wrong).toMatchObject({ canAccept: false, emailMismatch: true });
  });

  it("menerima ditolak untuk email berbeda dan email belum terverifikasi", async () => {
    const token = await tokenFromOutbox(pool, email("invitee"));
    expect(await code(acceptInvitation(pool, u.wrong, token))).toBe("invitation_invalid");
    // akun belum terverifikasi dengan email yang sama dengan undangan
    await inviteMember(pool, owner(), { email: email("unverified"), role: "staff" }, base);
    const t2 = await tokenFromOutbox(pool, email("unverified"));
    expect(await code(acceptInvitation(pool, u.unverified, t2))).toBe("invitation_invalid");
    await pool.query(`UPDATE users SET email_verified = true WHERE id = $1`, [u.unverified]);
    expect(await code(acceptInvitation(pool, u.unverified, t2))).toBe("ok");
  });

  it("SEKALI PAKAI: 5 penerimaan serentak → tepat satu berhasil; pemakaian ulang ditolak", async () => {
    const token = await tokenFromOutbox(pool, email("invitee"));
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => acceptInvitation(pool, u.invitee, token)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(r.reason).toBeInstanceOf(AppError);
    expect((await listMembers(pool, owner())).filter((m) => m.userId === u.invitee)).toHaveLength(1);
    expect(await code(acceptInvitation(pool, u.invitee, token))).toBe("invitation_invalid");
  });

  it("kedaluwarsa setelah 7 hari dan bisa dibatalkan; undangan baru boleh setelah pembatalan", async () => {
    await inviteMember(pool, owner(), { email: email("wrong"), role: "staff" }, base);
    const token = await tokenFromOutbox(pool, email("wrong"));
    expect(await code(acceptInvitation(pool, u.wrong, token, new Date(Date.now() + 8 * 24 * 3600_000)))).toBe("invitation_invalid");
    const pending = await listInvitations(pool, owner());
    const inv = pending.find((i) => i.email === email("wrong"))!;
    expect(inv).toBeTruthy();
    await revokeInvitation(pool, owner(), inv.id);
    expect(await code(acceptInvitation(pool, u.wrong, token))).toBe("invitation_invalid");
    expect((await listInvitations(pool, owner())).map((i) => i.email)).not.toContain(email("wrong"));
    expect(await code(inviteMember(pool, owner(), { email: email("wrong"), role: "staff" }, base))).toBe("ok");
  });

  it("admin tidak bisa membatalkan undangan admin; staf tidak bisa melihat daftar undangan", async () => {
    await inviteMember(pool, owner(), { email: `calon-admin-${sfx}@inv.local`, role: "admin" }, base);
    const inv = (await listInvitations(pool, owner())).find((i) => i.role === "admin")!;
    expect(await code(revokeInvitation(pool, { userId: u.admin, slug }, inv.id))).toBe("forbidden");
    expect(await code(listInvitations(pool, { userId: u.staff, slug }))).toBe("forbidden");
  });

  it("isolasi RLS: pengguna lain tidak bisa membaca undangan tanpa token yang cocok", async () => {
    const rows = await withTenant(pool, { userId: u.outsider, inviteTokenHash: "salah" }, (db) => db.execute(sql`SELECT * FROM workspace_invitations`));
    expect(rows.rows).toHaveLength(0);
    const none = await withTenant(pool, { userId: u.outsider }, (db) => db.execute(sql`SELECT * FROM workspace_invitations`));
    expect(none.rows).toHaveLength(0);
  });
});
