import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATION_LOCK_ID = 727_274;

/** Migrasi maju-saja dari packages/db/migrations. Advisory lock mencegah dua proses migrasi bersamaan. */
export async function migrateUp(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}
