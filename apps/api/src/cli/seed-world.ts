/** Migrates and loads the simulated network. Runs as the owner role. */
import { resolve } from "node:path";
import pg from "pg";
import { migrate } from "../db/migrate.js";
import { loadWorld } from "../sim/load.js";
import { buildWorld } from "../sim/world.js";

const url = process.env.MIGRATION_DATABASE_URL ?? "postgres://foundry:foundry@127.0.0.1:5432/foundry";
const configDir = resolve(process.env.CONFIG_DIR ?? "../../config");
const applied = await migrate(url);
const client = new pg.Client({ connectionString: url });
await client.connect();
const t0 = performance.now();
const counts = await loadWorld(
  client,
  buildWorld({ chargepoints: Number(process.env.CHARGEPOINTS ?? 9000) }),
  `${configDir}/docs`,
  resolve(process.env.TRUTH_FILE ?? "../../build/sim/truth.json"),
);
await client.end();
console.log(JSON.stringify({ applied, ...counts, seconds: Math.round((performance.now() - t0) / 100) / 10 }));
