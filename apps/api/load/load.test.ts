/**
 * Load and correctness under concurrency, over real HTTP with PostgreSQL and Redis: sandbox
 * throughput, the model gateway with a simulated provider latency (cache miss, hit, and a
 * stampede of identical questions), and the daily budget when many calls race for it.
 * Writes reports/load/latest.json. Run: pnpm --filter @foundry/api load
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { cpus } from "node:os";
import { serve } from "@hono/node-server";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropDatabase, freshDatabase, persona, ROOT, type Server, startServer } from "../test/helpers.js";

const SIM = { latencyMs: 300, msPerToken: 2 };
const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  machine: { cpus: cpus().length, model: cpus()[0]?.model ?? "?", node: process.version },
  simulatedProvider: SIM,
};

let db: Awaited<ReturnType<typeof freshDatabase>>;
let s: Server;
let http: ReturnType<typeof serve>;
let base = "";
let mara = "";

const pct = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return Math.round((a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0) * 10) / 10;
};

/** Sends `total` requests with at most `concurrency` in flight; returns latencies and outcomes. */
const drive = async (total: number, concurrency: number, make: (i: number) => { path: string; body: unknown }) => {
  const lat: number[] = [];
  const codes: Record<string, number> = {};
  let next = 0;
  const t0 = performance.now();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const r = make(i);
      const t = performance.now();
      const res = await fetch(`${base}${r.path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${mara}`, "content-type": "application/json" },
        body: JSON.stringify(r.body),
      });
      const body = (await res.json()) as { code?: string };
      lat.push(performance.now() - t);
      const k = res.ok ? String(res.status) : (body.code ?? String(res.status));
      codes[k] = (codes[k] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = (performance.now() - t0) / 1000;
  return { requests: total, concurrency, rps: Math.round(total / seconds), p50Ms: pct(lat, 50), p95Ms: pct(lat, 95), p99Ms: pct(lat, 99), outcomes: codes };
};

const metric = async (name: string) => {
  const text = await s.deps.metrics.registry.metrics();
  return [...text.matchAll(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\d+(?:\\.\\d+)?)$`, "gm"))].reduce((t, m) => t + Number(m[1]), 0);
};

const publishApp = async (manifest: Record<string, unknown>, code: string, test: { handler: string; input: unknown; contains: string }) => {
  const dev = s.deps.dev;
  if (!dev) throw new Error("dev idp off");
  const p = { ...(await s.deps.validateEntraToken(await dev.accessToken(persona("mara")))), via: "session" as const };
  const bundle = {
    manifest: { audience: { kind: "owner" }, models: [], connectors: [], collections: [], ...manifest },
    code,
    ui: { pages: [{ id: "main", title: "Main", blocks: [{ type: "markdown", text: "Load test" }] }] },
    tests: [{ name: "answers", handler: test.handler, input: test.input, expect: { contains: [test.contains] } }],
  };
  const v = await s.deps.registry.submit(p, bundle);
  expect(v.report.findings.filter((f) => f.severity === "block")).toEqual([]);
  expect(v.status).toBe("approved");
  await s.deps.registry.publish(p, v.app, v.number);
};

beforeAll(async () => {
  db = await freshDatabase(300);
  s = await startServer(db, { simLatencyMs: SIM.latencyMs, simMsPerToken: SIM.msPerToken, perMinute: 1_000_000 });
  http = serve({ fetch: s.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => http.once("listening", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const dev = s.deps.dev;
  if (!dev) throw new Error("dev idp off");
  mara = await dev.accessToken(persona("mara"));

  await publishApp(
    {
      id: "calc",
      name: "Calculator",
      description: "Pure computation in the sandbox, no platform calls",
      handlers: [{ name: "sum", input: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }],
      budget: { eurPerDay: 1, tokensPerUserPerDay: 1000 },
    },
    "export async function sum(input) { let t = 0; for (let i = 0; i < input.n; i++) t += i; return { t }; }\n",
    { handler: "sum", input: { n: 3 }, contains: "t" },
  );
  await publishApp(
    {
      id: "notes",
      name: "Notes",
      description: "Writes and lists records through row-level security",
      handlers: [{ name: "add", input: { type: "object", properties: { text: { type: "string", maxLength: 200 } }, required: ["text"] } }],
      collections: [{ name: "notes", scope: "private", classification: "internal", retentionDays: 30 }],
      budget: { eurPerDay: 1, tokensPerUserPerDay: 1000 },
    },
    'export async function add(input, ctx) { await ctx.store.put("notes", ctx.now() + Math.random(), { text: input.text }); const l = await ctx.store.list("notes", { limit: 20 }); return { n: l.length }; }\n',
    { handler: "add", input: { text: "x" }, contains: "n" },
  );
  const ask = 'export async function ask(input, ctx) { const r = await ctx.llm.chat({ model: "fast", messages: [{ role: "user", content: input.q }], maxTokens: 200 }); return { reply: r.text }; }\n';
  const askHandler = [{ name: "ask", input: { type: "object", properties: { q: { type: "string", maxLength: 500 } }, required: ["q"] } }];
  await publishApp(
    { id: "ask", name: "Ask", description: "One model call per question", handlers: askHandler, models: [{ alias: "fast", maxTokensPerCall: 200 }], budget: { eurPerDay: 50, tokensPerUserPerDay: 2_000_000 } },
    ask,
    { handler: "ask", input: { q: "hello" }, contains: "reply" },
  );
  await publishApp(
    { id: "ask-tight", name: "Ask on a tight budget", description: "One model call per question, one euro cent a day", handlers: askHandler, models: [{ alias: "fast", maxTokensPerCall: 200 }], budget: { eurPerDay: 0.01, tokensPerUserPerDay: 2_000_000 } },
    ask,
    { handler: "ask", input: { q: "hello" }, contains: "reply" },
  );
});

afterAll(async () => {
  mkdirSync(`${ROOT}/reports/load`, { recursive: true });
  writeFileSync(`${ROOT}/reports/load/latest.json`, `${JSON.stringify(report, null, 2)}\n`);
  http?.close();
  await s?.close();
  if (db) await dropDatabase(db.name);
});

describe("load", () => {
  it("runs sandboxed handlers: a fresh QuickJS runtime per call", async () => {
    await drive(50, 8, () => ({ path: "/v1/apps/calc/invoke", body: { handler: "sum", input: { n: 1000 } } }));
    const r = await drive(2000, 32, (i) => ({ path: "/v1/apps/calc/invoke", body: { handler: "sum", input: { n: 1000 + (i % 7) } } }));
    report.sandboxCompute = r;
    expect(r.outcomes["200"]).toBe(2000);
  });

  it("writes and reads app records through row-level security", async () => {
    const r = await drive(1000, 32, (i) => ({ path: "/v1/apps/notes/invoke", body: { handler: "add", input: { text: `note ${i}` } } }));
    report.sandboxStore = r;
    expect(r.outcomes["200"]).toBe(1000);
  });

  it("answers repeated questions from the cache and new ones from the provider", async () => {
    const calls0 = await metric("foundry_provider_calls_total");
    const miss = await drive(200, 20, (i) => ({ path: "/v1/apps/ask/invoke", body: { handler: "ask", input: { q: `What is the status of site ${i}?` } } }));
    const calls1 = await metric("foundry_provider_calls_total");
    const hit = await drive(1000, 20, (i) => ({ path: "/v1/apps/ask/invoke", body: { handler: "ask", input: { q: `What is the status of site ${i % 200}?` } } }));
    const calls2 = await metric("foundry_provider_calls_total");
    report.gatewayMiss = { ...miss, providerCalls: calls1 - calls0 };
    report.gatewayHit = { ...hit, providerCalls: calls2 - calls1 };
    expect(calls1 - calls0).toBe(200);
    expect(calls2 - calls1).toBe(0);
    expect(hit.p95Ms).toBeLessThan(miss.p50Ms);
  });

  it("makes one provider call for a stampede of identical new questions", async () => {
    const before = await metric("foundry_provider_calls_total");
    const r = await drive(100, 100, () => ({ path: "/v1/apps/ask/invoke", body: { handler: "ask", input: { q: "Which sites in Essen need a technician today?" } } }));
    const calls = (await metric("foundry_provider_calls_total")) - before;
    report.stampede = { ...r, providerCalls: calls };
    expect(r.outcomes["200"]).toBe(100);
    expect(calls).toBe(1);
  });

  it("never spends more than the daily budget when calls race for it", async () => {
    const r = await drive(200, 50, (i) => ({ path: "/v1/apps/ask-tight/invoke", body: { handler: "ask", input: { q: `Distinct question number ${i} about charge point health` } } }));
    const pool = new pg.Pool({ connectionString: db.ownerUrl });
    const spent = Number((await pool.query("select coalesce(sum(cost_micro_eur), 0)::bigint as s from foundry.invocations where app_id = 'ask-tight'")).rows[0]?.s);
    await pool.end();
    report.budgetRace = { ...r, budgetMicroEur: 10_000, spentMicroEur: spent };
    expect(spent).toBeLessThanOrEqual(10_000);
    expect(r.outcomes.BUDGET_EXHAUSTED ?? 0).toBeGreaterThan(0);
    expect((r.outcomes["200"] ?? 0) + (r.outcomes.BUDGET_EXHAUSTED ?? 0)).toBe(200);
  });
});
