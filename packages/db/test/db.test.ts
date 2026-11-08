import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../src/migrate-lib";

const url = process.env.DATABASE_URL;
const run = Math.random().toString(36).slice(2, 8); // token pembatalan unik global

describe.skipIf(!url)("database (Postgres asli)", () => {
  let pool: pg.Pool;
  let wsA: string;
  let wsB: string;
  let memberA: string;
  let clientA: string;
  let typeA: string;

  /** Jalankan sebagai role aplikasi dengan konteks workspace, seperti di produksi. */
  async function asApp<T>(workspaceId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE jadwalin_app");
      if (workspaceId) await c.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    await migrateUp(url!);
    pool = new pg.Pool({ connectionString: url });
    const suffix = Math.random().toString(36).slice(2, 8);
    const u = await pool.query(
      `INSERT INTO users (email, name) VALUES ($1, 'Owner') RETURNING id`,
      [`owner-${suffix}@test.local`],
    );
    const uid = u.rows[0].id;
    const a = await pool.query(
      `INSERT INTO workspaces (slug, name, owner_user_id) VALUES ($1, 'A', $2) RETURNING id`,
      [`a-${suffix}`, uid],
    );
    const b = await pool.query(
      `INSERT INTO workspaces (slug, name, owner_user_id) VALUES ($1, 'B', $2) RETURNING id`,
      [`b-${suffix}`, uid],
    );
    wsA = a.rows[0].id;
    wsB = b.rows[0].id;
    memberA = (
      await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id`, [wsA, uid])
    ).rows[0].id;
    clientA = (
      await pool.query(`INSERT INTO workspace_clients (workspace_id, name) VALUES ($1, 'Klien') RETURNING id`, [wsA])
    ).rows[0].id;
    typeA = (
      await pool.query(
        `INSERT INTO meeting_types (workspace_id, slug, title, duration_min, location_kind) VALUES ($1, 'konsultasi', 'Konsultasi', 30, 'link') RETURNING id`,
        [wsA],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO tickets (workspace_id, number, title) VALUES ($1, 1, 'Tiket A')`, [wsA]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  const book = (c: pg.PoolClient, range: string, token: string, status = "confirmed") =>
    c.query(
      `INSERT INTO bookings (workspace_id, meeting_type_id, member_id, client_id, during, starts_at, ends_at, status, cancel_token_hash)
       VALUES ($1, $2, $3, $4, $5::tstzrange, lower($5::tstzrange), upper($5::tstzrange), $6, $7)`,
      [wsA, typeA, memberA, clientA, range, status, token],
    );

  it("workspace B tidak bisa membaca tiket workspace A", async () => {
    const rowsB = await asApp(wsB, (c) => c.query("SELECT * FROM tickets"));
    expect(rowsB.rowCount).toBe(0);
    const rowsA = await asApp(wsA, (c) => c.query("SELECT * FROM tickets"));
    expect(rowsA.rowCount).toBe(1);
  });

  it("tanpa konteks workspace tidak ada baris terlihat (gagal tertutup)", async () => {
    const r = await asApp(null, (c) => c.query("SELECT * FROM tickets"));
    expect(r.rowCount).toBe(0);
  });

  it("workspace B tidak bisa menulis ke workspace A", async () => {
    await expect(
      asApp(wsB, (c) => c.query(`INSERT INTO tickets (workspace_id, number, title) VALUES ($1, 99, 'x')`, [wsA])),
    ).rejects.toThrow(/row-level security/);
  });

  it("booking bertumpuk untuk anggota yang sama ditolak", async () => {
    await asApp(wsA, (c) => book(c, "[2030-01-01 09:00+07, 2030-01-01 10:00+07)", `${run}-tok-1`));
    await expect(
      asApp(wsA, (c) => book(c, "[2030-01-01 09:30+07, 2030-01-01 10:30+07)", `${run}-tok-2`)),
    ).rejects.toThrow(/bookings_no_overlap/);
  });

  it("booking bersebelahan diperbolehkan dan yang dibatalkan membebaskan slot", async () => {
    await asApp(wsA, (c) => book(c, "[2030-01-01 10:00+07, 2030-01-01 11:00+07)", `${run}-tok-3`));
    await asApp(wsA, (c) =>
      c.query(`UPDATE bookings SET status = 'cancelled' WHERE cancel_token_hash = '${run}-tok-1'`),
    );
    await asApp(wsA, (c) => book(c, "[2030-01-01 09:00+07, 2030-01-01 10:00+07)", `${run}-tok-4`));
  });

  it("dua booking serentak pada slot sama: tepat satu berhasil", async () => {
    const attempts = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) =>
        asApp(wsA, (c) => book(c, "[2031-05-05 09:00+07, 2031-05-05 10:00+07)", `${run}-race-${i}`)),
      ),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
  });

  it("audit_log append-only untuk role aplikasi", async () => {
    await asApp(wsA, (c) =>
      c.query(`INSERT INTO audit_log (workspace_id, action, entity_type, entity_id) VALUES ($1, 'x', 'ticket', '1')`, [wsA]),
    );
    await expect(asApp(wsA, (c) => c.query(`DELETE FROM audit_log`))).rejects.toThrow(/permission denied/);
  });
});
