import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url).pathname;

/** Applies migrations/*.sql in order, each once, each in its own transaction. Runs as the owner role. */
export const migrate = async (url: string, dir = MIGRATIONS_DIR): Promise<string[]> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "create table if not exists public.schema_migrations (name text primary key, at timestamptz not null default now())",
    );
    await client.query("select pg_advisory_lock(7212)");
    const done = new Set((await client.query<{ name: string }>("select name from public.schema_migrations")).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      if (done.has(f)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(join(dir, f), "utf8"));
        await client.query("insert into public.schema_migrations (name) values ($1)", [f]);
        await client.query("commit");
        applied.push(f);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock(7212)").catch(() => undefined);
    await client.end();
  }
};
