import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../src/migrate-lib";
import { withTenant } from "../src/tenant";
import { sql } from "drizzle-orm";

/**
 * Audit keamanan skema: pagar otomatis agar perubahan di masa depan tidak diam-diam melemahkan isolasi.
 * Tabel baru WAJIB diklasifikasikan di sini (tenant dengan RLS, atau non-tenant yang disetujui secara eksplisit).
 */
const url = process.env.DATABASE_URL;

// Tabel tanpa kolom workspace_id yang memang bukan milik tenant, dengan alasannya.
const NON_TENANT = new Set([
  "users", // akun global; RLS aktif: hanya diri sendiri dan sesama anggota workspace aktif
  "sessions", "accounts", "verifications", "rate_limits", // milik Better Auth: TIDAK di-grant ke role aplikasi
  "rate_counters", // pembatas laju ber-hash, tanpa data pribadi
  "job_status", // status pekerjaan latar (pemantauan), tanpa data pribadi
  "webhook_inbox", // kotak masuk webhook: hanya role worker (tanpa hak app); diperiksa di tes pembayaran
  "data_requests", // milik pengguna; RLS berbasis pengguna (diperiksa terpisah di bawah)
  "__drizzle_migrations", // pencatat migrasi
]);
const APP = "jadwalin_app";
const WORKER = "jadwalin_worker";

describe.skipIf(!url)("audit keamanan skema (Postgres asli)", () => {
  let pool: pg.Pool;
  const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as T[];

  beforeAll(async () => {
    await migrateUp(url!);
    pool = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => pool?.end());

  async function tenantTables(): Promise<string[]> {
    const rows = await q<{ relname: string }>(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
      ORDER BY 1`);
    return rows.map((r) => r.relname);
  }

  it("setiap tabel diklasifikasikan: tenant (punya workspace_id), workspaces sendiri, atau non-tenant yang disetujui", async () => {
    const all = (await q<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname IN ('public', 'drizzle')`)).map((r) => r.tablename);
    const tenant = new Set(await tenantTables());
    const unclassified = all.filter((t) => !tenant.has(t) && !NON_TENANT.has(t) && t !== "workspaces");
    expect(unclassified, `Tabel baru belum diklasifikasikan (tambahkan workspace_id + RLS, atau setujui di NON_TENANT): ${unclassified.join(", ")}`).toEqual([]);
  });

  it("semua tabel tenant: RLS aktif, FORCE, dan punya policy tenant_isolation", async () => {
    const tables = [...(await tenantTables()), "workspaces"];
    expect(tables.length).toBeGreaterThan(15);
    for (const t of tables) {
      const [c] = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [`public.${t}`]);
      expect(c!.relrowsecurity, `${t}: RLS belum aktif`).toBe(true);
      expect(c!.relforcerowsecurity, `${t}: RLS belum FORCE`).toBe(true);
      const pol = await q(`SELECT 1 FROM pg_policy WHERE polrelid = $1::regclass AND polname = 'tenant_isolation'`, [`public.${t}`]);
      expect(pol.length, `${t}: tidak ada policy tenant_isolation`).toBe(1);
    }
  });

  it("tabel milik pengguna (data_requests): RLS aktif dan FORCE, dengan policy berbasis pengguna", async () => {
    const [c] = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.data_requests'::regclass`);
    expect([c!.relrowsecurity, c!.relforcerowsecurity]).toEqual([true, true]);
    expect((await q(`SELECT 1 FROM pg_policy WHERE polrelid = 'public.data_requests'::regclass AND polname = 'own_requests'`)).length).toBe(1);
    const [p] = await q<Record<string, boolean>>(`SELECT has_table_privilege($1,'public.data_requests','UPDATE') AS upd, has_table_privilege($1,'public.data_requests','DELETE') AS del`, [APP]);
    expect(p).toEqual({ upd: false, del: false });
  });

  it("users: RLS aktif; role aplikasi hanya boleh membaca", async () => {
    const [c] = await q<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.users'::regclass`);
    expect(c!.relrowsecurity).toBe(true);
    const [p] = await q<Record<string, boolean>>(`SELECT has_table_privilege($1,'public.users','SELECT') AS sel, has_table_privilege($1,'public.users','INSERT') AS ins, has_table_privilege($1,'public.users','UPDATE') AS upd, has_table_privilege($1,'public.users','DELETE') AS del`, [APP]);
    expect(p).toEqual({ sel: true, ins: false, upd: false, del: false });
  });

  it("tabel milik auth tidak dapat disentuh role aplikasi maupun worker", async () => {
    for (const t of ["sessions", "accounts", "verifications", "rate_limits"]) {
      for (const role of [APP, WORKER]) {
        const [p] = await q<{ any: boolean }>(`SELECT (has_table_privilege($1,$2,'SELECT') OR has_table_privilege($1,$2,'INSERT') OR has_table_privilege($1,$2,'UPDATE') OR has_table_privilege($1,$2,'DELETE')) AS any`, [role, `public.${t}`]);
        expect(p!.any, `${role} punya akses ke ${t}`).toBe(false);
      }
    }
  });

  it("tak ada hak berbahaya (TRUNCATE/REFERENCES/TRIGGER) dan jejak tak bisa diubah", async () => {
    const tables = (await q<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.tablename);
    for (const t of tables) {
      for (const role of [APP, WORKER]) {
        for (const priv of ["TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const [p] = await q<{ ok: boolean }>(`SELECT has_table_privilege($1,$2,$3) AS ok`, [role, `public.${t}`, priv]);
          expect(p!.ok, `${role} punya ${priv} pada ${t}`).toBe(false);
        }
      }
    }
    for (const [t, role] of [["audit_log", APP], ["audit_log", WORKER], ["ticket_events", APP], ["ticket_comments", APP]] as const) {
      for (const priv of ["UPDATE", "DELETE"]) {
        const [p] = await q<{ ok: boolean }>(`SELECT has_table_privilege($1,$2,$3) AS ok`, [role, `public.${t}`, priv]);
        expect(p!.ok, `${role} bisa ${priv} ${t} (harus append-only)`).toBe(false);
      }
    }
  });

  it("role aplikasi dan worker: NOLOGIN, bukan superuser, tanpa BYPASSRLS, dan bukan pemilik tabel", async () => {
    const roles = await q<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(`SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname IN ($1, $2)`, [APP, WORKER]);
    expect(roles).toHaveLength(2);
    for (const r of roles) expect([r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolcreaterole, r.rolcreatedb], r.rolname).toEqual([false, false, false, false, false]);
    const owned = await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner IN ($1, $2)`, [APP, WORKER]);
    expect(owned).toEqual([]);
  });

  it("setiap policy RESTRICTIVE hanya berlaku untuk jadwalin_app (jangan membatasi role worker yang dialihkan di tengah transaksi)", async () => {
    const rows = await q<{ polname: string; tbl: string; roles: string }>(`SELECT polname, polrelid::regclass::text AS tbl, polroles::regrole[]::text AS roles FROM pg_policy WHERE NOT polpermissive`);
    expect(rows.length).toBeGreaterThan(30);
    const wrong = rows.filter((r) => r.roles !== `{${APP}}`);
    expect(wrong, `Policy RESTRICTIVE tanpa TO ${APP}: ${wrong.map((w) => `${w.tbl}.${w.polname}`).join(", ")}`).toEqual([]);
  });

  it("tidak ada fungsi SECURITY DEFINER (RLS FORCE membuatnya tidak berguna di produksi dan memperluas hak secara diam-diam)", async () => {
    const rows = await q<{ proname: string }>(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef`);
    expect(rows).toEqual([]);
  });

  it("fungsi pembantu konteks bersifat STABLE dan hanya membaca GUC", async () => {
    const rows = await q<{ proname: string; provolatile: string }>(`SELECT proname, provolatile FROM pg_proc WHERE proname IN ('current_workspace_id','current_user_id','is_client_actor','is_public_actor','current_booking_token_hash')`);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.provolatile, r.proname).toBe("s");
  });

  it("graf policy tidak punya siklus: setiap perintah pada setiap tabel bisa direncanakan untuk setiap aktor", async () => {
    // Postgres menolak policy yang saling merujuk ("infinite recursion detected in policy") saat perintah ditulis ulang.
    // EXPLAIN tidak mengeksekusi apa pun, tetapi memicu penulisan ulang yang sama.
    const NIL = "00000000-0000-0000-0000-000000000000";
    const tables = [...(await tenantTables()), "workspaces", "users"];
    const actors: [string, Record<string, string>][] = [
      ["staf", { "app.user_id": NIL, "app.workspace_id": NIL }],
      ["klien", { "app.user_id": NIL, "app.workspace_id": NIL, "app.actor_kind": "client" }],
      ["tamu", { "app.user_id": NIL, "app.workspace_id": NIL, "app.actor_kind": "public", "app.booking_token_hash": "x" }],
    ];
    for (const [label, gucs] of actors) {
      const client = await pool.connect();
      try {
        for (const t of tables) {
          for (const stmt of [`SELECT * FROM ${t}`, `UPDATE ${t} SET id = id WHERE false`, `DELETE FROM ${t} WHERE false`, `INSERT INTO ${t} SELECT * FROM ${t} WHERE false`]) {
            if (t === "users" && !stmt.startsWith("SELECT")) continue; // users: role aplikasi hanya membaca
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE jadwalin_app");
            for (const [k, v] of Object.entries(gucs)) await client.query("SELECT set_config($1, $2, true)", [k, v]);
            try {
              await client.query(`EXPLAIN ${stmt}`);
            } catch (e) {
              const msg = (e as Error).message;
              expect(msg, `${label}: ${stmt}`).not.toMatch(/infinite recursion/);
              // galat lain (mis. tanpa hak pada kolom id) bukan urusan tes ini
            } finally {
              await client.query("ROLLBACK");
            }
          }
        }
      } finally {
        client.release();
      }
    }
  });

  describe("matriks lintas-tenant: tak satu pun baris workspace lain terlihat oleh aktor mana pun", () => {
    const NIL = "00000000-0000-0000-0000-000000000000";
    let ownerId: string;
    let strangerId: string;
    let wsId: string;
    const sfx = Math.random().toString(36).slice(2, 8);

    beforeAll(async () => {
      ownerId = (await q<{ id: string }>(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'Pemilik', true) RETURNING id`, [`audit-o-${sfx}@x.local`]))[0]!.id;
      strangerId = (await q<{ id: string }>(`INSERT INTO users (email, name, email_verified) VALUES ($1, 'Asing', true) RETURNING id`, [`audit-s-${sfx}@x.local`]))[0]!.id;
      wsId = (await q<{ id: string }>(`INSERT INTO workspaces (slug, name, owner_user_id) VALUES ($1, 'Audit', $2) RETURNING id`, [`audit-${sfx}`, ownerId]))[0]!.id;
    });

    // Setiap aktor diberi konteks workspace B (`wsId`); baris dengan workspace_id lain tidak boleh muncul.
    const actors: [string, (fn: (count: (table: string) => Promise<number>) => Promise<void>) => Promise<void>][] = [
      ["staf workspace B", (fn) => withTenant(pool, { userId: ownerId, workspaceId: wsId }, (db) => fn(async (t) => Number((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === "workspaces" ? "id" : "workspace_id"} IS DISTINCT FROM '${wsId}'`))).rows[0]!.n)))],
      ["klien workspace B", (fn) => withTenant(pool, { userId: strangerId, workspaceId: wsId, actor: "client" }, (db) => fn(async (t) => Number((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === "workspaces" ? "id" : "workspace_id"} IS DISTINCT FROM '${wsId}'`))).rows[0]!.n)))],
      ["tamu workspace B", (fn) => withTenant(pool, { userId: NIL, workspaceId: wsId, actor: "public" }, (db) => fn(async (t) => Number((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === "workspaces" ? "id" : "workspace_id"} IS DISTINCT FROM '${wsId}'`))).rows[0]!.n)))],
      ["tamu dengan token palsu, tanpa workspace", (fn) => withTenant(pool, { userId: NIL, actor: "public", bookingTokenHash: "token-palsu" }, (db) => fn(async (t) => Number((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`))).rows[0]!.n)))],
      ["pengguna asing tanpa konteks workspace", (fn) => withTenant(pool, { userId: strangerId }, (db) => fn(async (t) => Number((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`))).rows[0]!.n)))],
      ["pengguna dengan token undangan palsu", (fn) => withTenant(pool, { userId: strangerId, inviteTokenHash: "palsu" }, (db) => fn(async (t) => Number((await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`))).rows[0]!.n)))],
    ];

    for (const [label, run] of actors) {
      it(`${label}: nol baris lintas-tenant di semua tabel`, async () => {
        const tables = [...(await tenantTables()), "workspaces"];
        await run(async (count) => {
          for (const t of tables) {
            const leaked = await count(t);
            // pemilik melihat barisnya sendiri; yang diuji hanyalah baris di luar workspace B / tanpa hak
            if (label === "staf workspace B") expect(leaked, `${t}`).toBe(0);
            else if (label.startsWith("klien") || label.startsWith("tamu workspace")) expect(leaked, `${t}`).toBe(0);
            else expect(leaked, `${t}`).toBe(0);
          }
        });
      });
    }
  });
});
