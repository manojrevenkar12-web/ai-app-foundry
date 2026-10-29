import { migrate } from "../db/migrate.js";

console.log(
  JSON.stringify({ applied: await migrate(process.env.MIGRATION_DATABASE_URL ?? "postgres://foundry:foundry@127.0.0.1:5432/foundry") }),
);
