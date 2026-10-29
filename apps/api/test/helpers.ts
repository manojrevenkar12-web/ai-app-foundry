import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { PERSONAS } from "../src/identity/dev-idp.js";
import { createServer } from "../src/server.js";
import { loadWorld } from "../src/sim/load.js";
import { buildWorld } from "../src/sim/world.js";

const ADMIN = process.env.TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const HOST = process.env.TEST_PG_HOST ?? "127.0.0.1:5432";
const OWNER = process.env.TEST_OWNER ?? "foundry:foundry";
const RUNTIME = process.env.TEST_RUNTIME ?? "foundry_app:foundry_app";
export const ROOT = resolve(import.meta.dirname, "../../..");

/** A fresh database with the migrations and a small simulated network. */
export const freshDatabase = async (chargepoints = 400) => {
  const name = `foundry_t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`create database ${name} owner ${OWNER.split(":")[0]}`);
  await admin.end();
  const ownerUrl = `postgres://${OWNER}@${HOST}/${name}`;
  await migrate(ownerUrl);
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  await loadWorld(c, buildWorld({ chargepoints }), `${ROOT}/config/docs`, `${ROOT}/build/test/truth-${name}.json`);
  await c.end();
  return { name, ownerUrl, runtimeUrl: `postgres://${RUNTIME}@${HOST}/${name}` };
};

export const dropDatabase = async (name: string) => {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.end();
};

/** A stand-in for the data science team's fault model service. */
export const faultModelStub = async () => {
  const srv = createHttpServer((req, res) => {
    const id = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ id, causes: [{ cause: "rcd_trip", probability: 0.7 }], evidence: ["GroundFailure x4"], modelVersion: "stub" }),
    );
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() };
};

let redisDb = 1;
export const startServer = async (
  db: { runtimeUrl: string },
  opts: Parameters<typeof createServer>[1] = {},
  faultUrl = "http://127.0.0.1:9",
) => {
  const n = redisDb++;
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: db.runtimeUrl,
    REDIS_URL: `redis://127.0.0.1:6379/${n}`,
    CONFIG_DIR: `${ROOT}/config`,
    DEV_IDP: "on",
    SESSION_SECRET: "test-session-secret-test-session-secret",
    PUBLIC_URL: "http://api.test",
    CONSOLE_URL: "http://console.test",
    FAULT_MODEL_URL: faultUrl,
  });
  const s = await createServer(config, opts);
  await s.deps.redis.flushdb();
  return s;
};

export type Server = Awaited<ReturnType<typeof startServer>>;
export const persona = (key: string) => {
  const p = PERSONAS.find((x) => x.key === key);
  if (!p) throw new Error(key);
  return p;
};

/** A client acting as a persona with an Entra-shaped access token. */
export interface Client {
  token: string;
  get: (p: string) => Promise<Reply>;
  post: (p: string, b?: unknown) => Promise<Reply>;
  del: (p: string) => Promise<Reply>;
}
export interface Reply {
  status: number;
  body: Record<string, unknown> & Array<Record<string, unknown>>;
  text: string;
  headers: globalThis.Headers;
}
export const as = async (s: Server, key: string): Promise<Client> => {
  const dev = s.deps.dev;
  if (!dev) throw new Error("dev idp off");
  const token = await dev.accessToken(persona(key));
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await s.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json as Record<string, unknown> & Array<Record<string, unknown>>, text, headers: res.headers };
  };
  return {
    token,
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown) => call("POST", p, b ?? {}),
    del: (p: string) => call("DELETE", p),
  };
};
