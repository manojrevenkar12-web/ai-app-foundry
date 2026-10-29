import pg from "pg";

export const createPool = (url: string, max = 20) => {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: "foundry-api",
  });
  pool.on("error", () => {
    // an idle client lost its connection; the pool replaces it
  });
  return pool;
};

export type Pool = pg.Pool;
