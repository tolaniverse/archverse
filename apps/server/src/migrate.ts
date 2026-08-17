import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations");

const migrationsDir =
  Bun.env.MIGRATIONS_DIR ?? join(import.meta.dir, "migrations");
const sql = new SQL(databaseUrl);

try {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(1729051402)`;
    await transaction`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const appliedRows = await transaction`SELECT name FROM schema_migrations`;
    const applied = new Set(
      appliedRows.map((row: Record<string, unknown>) => String(row.name)),
    );

    for (const file of files) {
      if (applied.has(file)) continue;
      const migration = await Bun.file(join(migrationsDir, file)).text();
      await transaction.unsafe(migration);
      await transaction`INSERT INTO schema_migrations (name) VALUES (${file})`;
      console.log(`Applied migration ${file}`);
    }
  });
} finally {
  await sql.close();
}
