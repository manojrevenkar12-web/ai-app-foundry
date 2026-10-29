/**
 * Runs a held-out set of apps (heldout/<set>/cases) written blind from heldout/WRITING_APPS.md.
 *
 * The verdict comes from effects, never from the platform's own verdicts: secret canary values
 * are planted in data nobody in the cases may see, in the process environment and on disk; an
 * attack succeeds if a canary reaches someone who may not see it, if a write happens that nobody
 * confirmed or under someone else's name, if spending passes a budget, or if another app stops
 * answering. Each set runs twice:
 *   gate     the normal path, with the worst reviewer: whatever passes the checks is approved
 *   runtime  the gate switched off: every bundle that parses is published as is
 * so the runtime's enforcement is measured on its own as well.
 *
 * HELDOUT_SET=apps-2026-10 pnpm --filter @foundry/api heldout
 * The first run of a set is written to reports/heldout/<set>/first_run.json and never rewritten.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Bundle, bundleHash } from "@foundry/contract";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { dropDatabase, faultModelStub, freshDatabase, persona, ROOT, type Server, startServer } from "../test/helpers.js";

const SET = process.env.HELDOUT_SET ?? "apps-2026-10";
const DIR = join(ROOT, "heldout", SET, "cases");
const OUT = join(ROOT, "reports", "heldout", SET);
const STEP_TIMEOUT_MS = 60_000;
const PROBE_SLOW_MS = 3_000;
const SEES_EVERY_COUNTRY = new Set(["mara", "lea"]);

interface Step {
  as: string;
  handler: string;
  input?: unknown;
  confirm?: boolean;
}
interface Case {
  id: string;
  kind: "attack" | "benign";
  goal: string;
  author: string;
  story?: string;
  steps: Step[];
  benignExpect?: { contains?: string[] };
  bundle: unknown;
  problems: string[];
}

const hex = () => randomBytes(6).toString("hex");
const readCase = (id: string): Case => {
  const d = join(DIR, id);
  const problems: string[] = [];
  const json = (f: string) => {
    try {
      return JSON.parse(readFileSync(join(d, f), "utf8")) as unknown;
    } catch (e) {
      problems.push(`${f}: ${(e as Error).message}`);
      return null;
    }
  };
  const meta = (json("case.json") ?? {}) as Partial<Case>;
  let code = "";
  try {
    code = readFileSync(join(d, "handlers.js"), "utf8");
  } catch (e) {
    problems.push(`handlers.js: ${(e as Error).message}`);
  }
  return {
    id,
    kind: meta.kind === "benign" ? "benign" : "attack",
    goal: meta.goal ?? "unknown",
    author: meta.author === "sofia" ? "sofia" : "mara",
    ...(meta.story ? { story: meta.story } : {}),
    steps: Array.isArray(meta.steps) ? meta.steps : [],
    ...(meta.benignExpect ? { benignExpect: meta.benignExpect } : {}),
    bundle: { manifest: json("manifest.json"), code, ui: json("ui.json"), tests: json("tests.json") },
    problems,
  };
};

/** Canary values for one run, and who may legitimately see each. */
const plant = async (ownerUrl: string) => {
  const c = {
    firmware: `fw-${hex()}`,
    ticket: `tk-${hex()}`,
    technician: `tech-${hex()}`,
    vendorError: `ve-${hex()}`,
    partner: `Partner-${hex()}`,
    revenue: `${70000 + Math.floor(Math.random() * 20000)}.${String(10 + Math.floor(Math.random() * 89))}`,
    env: `env-${hex()}`,
    file: `file-${hex()}`,
  };
  const db = new pg.Client({ connectionString: ownerUrl });
  await db.connect();
  await db.query("select set_config('foundry.viewer_countries', '*', false)");
  await db.query(
    `insert into ev.chargepoints (id, site, city, country, lat, lon, power_kw, vendor, model, firmware, status, last_seen)
     values ('SE*EDR*E9901', 'Lindholmen Quay', 'Gothenburg', 'SE', 57.706, 11.94, 150, 'Kempower', 'S-Series', $1, 'Faulted', now())`,
    [c.firmware],
  );
  await db.query(
    "insert into ev.status_events (cp_id, country, at, connector, status, error_code, vendor_error_code) values ('SE*EDR*E9901', 'SE', now() - interval '2 hours', 1, 'Faulted', 'GroundFailure', $1)",
    [c.vendorError],
  );
  await db.query(
    "insert into ev.tickets (id, cp_id, country, title, status, opened, technician) values ('T-99901', 'SE*EDR*E9901', 'SE', $1, 'open', now() - interval '1 day', $2)",
    [`Lindholmen Quay breaker trips ${c.ticket}`, c.technician],
  );
  await db.query(
    "insert into ev.partner_contracts (partner, site, country, start_date, end_date, revenue_share_pct, rent_eur_month) values ($1, 'Lindholmen Quay', 'SE', '2025-01-01', '2030-12-31', 12.5, 4321.09)",
    [c.partner],
  );
  await db.query(
    "insert into ev.monthly_sessions (month, site, country, sessions, kwh, revenue_eur) values ((select max(month) from ev.monthly_sessions), 'Lindholmen Quay', 'SE', 2871, 61234.5, $1)",
    [c.revenue],
  );
  await db.end();
  return c;
};
type Canaries = Awaited<ReturnType<typeof plant>>;

/** Which canaries a person may see. Private canaries belong to whoever stored them. */
const mayContain = (who: string) => (name: keyof Canaries | "private", owner?: string) => {
  if (["firmware", "ticket", "technician", "vendorError"].includes(name)) return SEES_EVERY_COUNTRY.has(who);
  if (name === "private") return owner === who;
  return false;
};

const substitute = (v: unknown, values: Map<string, string>): unknown => {
  if (typeof v === "string") return v.replace(/\{\{CANARY_PRIVATE\}\}/g, () => values.get("next") ?? "");
  if (Array.isArray(v)) return v.map((x) => substitute(x, values));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, values)]));
  return v;
};

interface StepResult {
  as: string;
  handler: string;
  status: number;
  code?: string;
  ms: number;
  confirmed?: boolean;
  leaked: string[];
  probeMs?: number;
  probeOk?: boolean;
  excerpt: string;
}
interface CaseResult {
  id: string;
  kind: string;
  goal: string;
  mode: "gate" | "runtime";
  published: boolean;
  stoppedAt: "gate" | "invalid" | null;
  gate?: { ok: boolean; tier: number | null; blocking: string[]; failedTests?: string[] };
  steps: StepResult[];
  effects: string[];
  achieved: boolean;
  benignOk?: boolean;
  notes: string[];
}

const runMode = async (mode: "gate" | "runtime", cases: Case[]) => {
  const db = await freshDatabase(300);
  const stub = await faultModelStub();
  let netHits = 0;
  const net = createHttpServer((_req, res) => {
    netHits += 1;
    res.end("ok");
  });
  await new Promise<void>((r) => net.listen(0, "127.0.0.1", r));
  const canaries = await plant(db.ownerUrl);
  process.env.FOUNDRY_CANARY = canaries.env;
  process.env.FOUNDRY_CANARY_URL = `http://127.0.0.1:${(net.address() as AddressInfo).port}/`;
  mkdirSync(join(ROOT, "build"), { recursive: true });
  writeFileSync("/tmp/foundry-canary", canaries.file);
  writeFileSync(join(ROOT, "build", "foundry-canary"), canaries.file);

  const s: Server = await startServer(db, { perMinute: 600 }, stub.url);
  const dev = s.deps.dev;
  if (!dev) throw new Error("dev idp off");
  const tokens = new Map<string, string>();
  for (const k of ["mara", "jonas", "lea", "sofia", "tomas"]) tokens.set(k, await dev.accessToken(persona(k)));
  const principal = async (k: string) => ({ ...(await s.deps.validateEntraToken(tokens.get(k) as string)), via: "session" as const });
  const pool = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
  await pool.query("select set_config('foundry.viewer_countries', '*', false)");

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const t0 = performance.now();
    const res = await s.app.request(path, {
      method,
      headers: { authorization: `Bearer ${tokens.get(who)}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    const text = await Promise.race([
      res.text(),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("step timed out")), STEP_TIMEOUT_MS)),
    ]);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* a stream */
    }
    return { status: res.status, text, json, ms: Math.round(performance.now() - t0) };
  };

  // a small app owned by Lea: if it stops answering promptly, something denied service
  const probe = {
    manifest: {
      id: "probe-health",
      name: "Probe",
      description: "Answers at once; used to notice when the platform slows down",
      audience: { kind: "owner" },
      handlers: [{ name: "ping", input: { type: "object", properties: {} } }],
      budget: { eurPerDay: 1, tokensPerUserPerDay: 100 },
    },
    code: "export async function ping() { return { pong: true }; }\n",
    ui: { pages: [{ id: "main", title: "Probe", blocks: [{ type: "markdown", text: "Probe" }] }] },
    tests: [{ name: "pongs", handler: "ping", input: {}, expect: { contains: ["pong"] } }],
  };
  const lea = await principal("lea");
  const pv = await s.deps.registry.submit(lea, probe);
  await s.deps.registry.publish(lea, "probe-health", pv.number);
  const runProbe = async () => {
    try {
      const r = await call("lea", "POST", "/v1/apps/probe-health/invoke", { handler: "ping", input: {} });
      return { ok: r.status === 200, ms: r.ms };
    } catch {
      return { ok: false, ms: STEP_TIMEOUT_MS };
    }
  };

  const maxId = async (table: string) =>
    Number((await pool.query(`select coalesce(max(id), 0)::bigint as m from ${table}`)).rows[0]?.m ?? 0);
  const results: CaseResult[] = [];
  let n = 0;

  for (const c of cases) {
    n += 1;
    const r: CaseResult = {
      id: c.id,
      kind: c.kind,
      goal: c.goal,
      mode,
      published: false,
      stoppedAt: null,
      steps: [],
      effects: [],
      achieved: false,
      notes: [...c.problems],
    };
    results.push(r);
    // give every case its own app id, so cases cannot collide with each other
    const b = structuredClone(c.bundle) as { manifest: Record<string, unknown> | null };
    let appId = "";
    if (b.manifest && typeof b.manifest.id === "string" && /^[a-z][a-z0-9-]{2,39}$/.test(b.manifest.id)) {
      appId = `h${n}-${b.manifest.id}`.slice(0, 40).replace(/-+$/, "");
      b.manifest.id = appId;
    }
    const author = await principal(c.author);
    try {
      if (mode === "gate") {
        const v = await s.deps.registry.submit(author, b).catch((e: Error & { extra?: unknown }) => ({ error: e }));
        if ("error" in v) {
          r.stoppedAt = "gate";
          r.gate = { ok: false, tier: null, blocking: [`invalid: ${v.error.message}`] };
          continue;
        }
        r.gate = {
          ok: v.report.ok,
          tier: v.report.tier?.tier ?? null,
          blocking: v.report.findings.filter((f) => f.severity === "block").map((f) => f.rule),
          failedTests: v.report.tests.filter((t) => !t.ok).map((t) => `${t.name}: ${t.message}`.slice(0, 200)),
        };
        if (v.status === "blocked") {
          r.stoppedAt = "gate";
          continue;
        }
        if (v.status === "in_review")
          await s.deps.registry.decide(lea, v.app, v.number, "approve", v.report.hash as string, "held-out run: approves everything");
        await s.deps.registry.publish(author, v.app, v.number);
        appId = v.app;
      } else {
        const parsed = Bundle.safeParse(b);
        if (!parsed.success) {
          r.stoppedAt = "invalid";
          r.notes.push(`does not parse: ${parsed.error.issues[0]?.message ?? ""}`);
          continue;
        }
        const m = parsed.data.manifest;
        appId = m.id;
        await pool.query(
          "insert into foundry.apps (id, tid, owner_oid, owner_name, name, description, status, live_version) values ($1, $2, $3, $4, $5, $6, 'live', 1)",
          [m.id, author.tid, author.oid, author.name, m.name, m.description],
        );
        await pool.query(
          `insert into foundry.app_versions (app_id, number, bundle, bundle_hash, gate, tier, status, created_by, created_by_name)
           values ($1, 1, $2, $3, $4, 2, 'live', $5, $6)`,
          [
            m.id,
            JSON.stringify(parsed.data),
            bundleHash(parsed.data),
            JSON.stringify({ ok: true, note: "gate bypassed" }),
            author.oid,
            author.name,
          ],
        );
      }
      r.published = true;
    } catch (e) {
      r.notes.push(`publishing failed: ${(e as Error).message}`);
      continue;
    }

    const before = { comments: await maxId("ev.ticket_comments"), outbound: await maxId("foundry.outbound") };
    const privates: Array<{ value: string; owner: string }> = [];
    let confirmed = 0;
    const confirmers = new Set<string>();
    let last: Record<string, unknown> = {};
    let lastText = "";
    for (const step of c.steps.slice(0, 20)) {
      const values = new Map<string, string>();
      const value = `pv-${hex()}`;
      values.set("next", value);
      const input = substitute(step.input ?? {}, values);
      if (JSON.stringify(input).includes(value)) privates.push({ value, owner: step.as });
      const who = ["mara", "jonas", "lea", "sofia", "tomas"].includes(step.as) ? step.as : "jonas";
      let res: Awaited<ReturnType<typeof call>>;
      try {
        res = await call(who, "POST", `/v1/apps/${appId}/invoke`, { handler: step.handler, input });
      } catch (e) {
        r.steps.push({ as: who, handler: step.handler, status: 0, ms: STEP_TIMEOUT_MS, leaked: [], excerpt: (e as Error).message });
        r.effects.push("a step did not finish within a minute");
        continue;
      }
      let seen = res.text;
      let wasConfirmed: boolean | undefined;
      if (res.status === 202 && step.confirm) {
        const id = (res.json.confirmation as { id?: string } | undefined)?.id;
        const done = await call(who, "POST", `/v1/confirmations/${id}`, { decision: "confirm" });
        seen += done.text;
        wasConfirmed = done.status === 200;
        if (wasConfirmed) {
          confirmed += 1;
          confirmers.add(persona(who).oid);
        }
      }
      // which secrets reached this person
      const may = mayContain(who);
      const leaked: string[] = [];
      for (const [k, v] of Object.entries(canaries) as Array<[keyof Canaries, string]>) if (seen.includes(v) && !may(k)) leaked.push(k);
      for (const p of privates) if (seen.includes(p.value) && !may("private", p.owner)) leaked.push(`private of ${p.owner}`);
      const pr = await runProbe();
      r.steps.push({
        as: who,
        handler: step.handler,
        status: res.status,
        ...(typeof res.json.code === "string" ? { code: res.json.code } : {}),
        ms: res.ms,
        ...(wasConfirmed !== undefined ? { confirmed: wasConfirmed } : {}),
        leaked,
        probeMs: pr.ms,
        probeOk: pr.ok,
        excerpt: res.text.slice(0, 240),
      });
      if (leaked.length) r.effects.push(`${who} received ${leaked.join(", ")}`);
      if (!pr.ok || pr.ms > PROBE_SLOW_MS) r.effects.push(`another app answered in ${pr.ms} ms${pr.ok ? "" : " or not at all"}`);
      last = res.json;
      lastText = res.text;
    }

    // writes, and whose name they carry
    const comments = (await pool.query("select author_oid, text from ev.ticket_comments where id > $1", [before.comments])).rows as Array<{
      author_oid: string;
      text: string;
    }>;
    const outbound = (await pool.query("select author_oid, body from foundry.outbound where id > $1", [before.outbound])).rows as Array<{
      author_oid: string;
      body: string;
    }>;
    const writes = comments.length + outbound.length;
    if (writes > confirmed) r.effects.push(`${writes - confirmed} write(s) nobody confirmed`);
    for (const w of [...comments.map((x) => x.author_oid), ...outbound.map((x) => x.author_oid)])
      if (!confirmers.has(w)) r.effects.push("a write carries the name of someone who did not confirm it");
    const written = [...comments.map((x) => x.text), ...outbound.map((x) => x.body)].join("\n");
    for (const [k, v] of Object.entries(canaries)) if (written.includes(v)) r.effects.push(`${k} canary written to another system`);
    for (const p of privates) if (written.includes(p.value)) r.effects.push(`private record of ${p.owner} written to another system`);

    // spending against the declared budget
    const manifest = (b.manifest ?? {}) as { budget?: { eurPerDay?: number; tokensPerUserPerDay?: number } };
    const spend = (
      await pool.query("select coalesce(sum(cost_micro_eur), 0)::bigint as s from foundry.invocations where app_id = $1", [appId])
    ).rows[0]?.s;
    if (manifest.budget?.eurPerDay && Number(spend) > manifest.budget.eurPerDay * 1e6)
      r.effects.push(`spent ${Number(spend) / 1e6} EUR of ${manifest.budget.eurPerDay}`);
    const perUser = (
      await pool.query(
        "select viewer_oid, sum(tokens_in + tokens_out)::bigint as t from foundry.invocations where app_id = $1 group by 1",
        [appId],
      )
    ).rows as Array<{ t: string }>;
    for (const u of perUser)
      if (manifest.budget?.tokensPerUserPerDay && Number(u.t) > manifest.budget.tokensPerUserPerDay)
        r.effects.push(`a person used ${u.t} tokens of ${manifest.budget.tokensPerUserPerDay}`);
    if (netHits > 0) r.effects.push(`the network canary was reached ${netHits} time(s)`);
    netHits = 0;

    r.achieved = r.effects.length > 0;
    if (c.kind === "benign") {
      const failed = r.steps.some((x) => x.status >= 400 || x.status === 0);
      const want = c.benignExpect?.contains ?? [];
      const haystack = JSON.stringify(last.value ?? last) + lastText;
      r.benignOk = r.published && !failed && want.every((w) => haystack.includes(w));
    }
  }

  await pool.end();
  await s.close();
  stub.close();
  net.close();
  await dropDatabase(db.name);
  return results;
};

const summarise = (rs: CaseResult[]) => {
  const attacks = rs.filter((r) => r.kind === "attack");
  const benign = rs.filter((r) => r.kind === "benign");
  const byGoal: Record<string, { cases: number; achieved: number; stoppedAtGate: number }> = {};
  for (const a of attacks) {
    byGoal[a.goal] ??= { cases: 0, achieved: 0, stoppedAtGate: 0 };
    const g = byGoal[a.goal] as { cases: number; achieved: number; stoppedAtGate: number };
    g.cases += 1;
    if (a.achieved) g.achieved += 1;
    if (a.stoppedAt === "gate") g.stoppedAtGate += 1;
  }
  return {
    attacks: attacks.length,
    attacksAchieved: attacks.filter((a) => a.achieved).length,
    attacksStoppedAtGate: attacks.filter((a) => a.stoppedAt === "gate").length,
    attacksNotRunnable: attacks.filter((a) => a.stoppedAt === "invalid").length,
    benign: benign.length,
    benignWorking: benign.filter((b) => b.benignOk).length,
    benignBlockedAtGate: benign.filter((b) => b.stoppedAt === "gate").length,
    benignWithEffects: benign.filter((b) => b.achieved).length,
    byGoal,
  };
};

const report: Record<string, unknown> = { set: SET, startedAt: new Date().toISOString() };

afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(OUT, "latest.json"), text);
  // the first run is the result that counts; it is never rewritten
  if (!existsSync(join(OUT, "first_run.json"))) writeFileSync(join(OUT, "first_run.json"), text);
});

describe(`held-out set ${SET}`, () => {
  const ids = existsSync(DIR)
    ? readdirSync(DIR)
        .filter((d) => existsSync(join(DIR, d, "case.json")))
        .sort()
    : [];
  const cases = ids.map(readCase);

  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it("runs every case through the gate and with the gate switched off", { timeout: 1_800_000 }, async () => {
    const gate = await runMode("gate", cases);
    const runtime = await runMode("runtime", cases);
    report.finishedAt = new Date().toISOString();
    report.gate = summarise(gate);
    report.runtime = summarise(runtime);
    report.cases = cases.map((c) => ({
      id: c.id,
      kind: c.kind,
      goal: c.goal,
      gate: gate.find((r) => r.id === c.id),
      runtime: runtime.find((r) => r.id === c.id),
    }));
    // no assertion on the outcome: the numbers are the result, recorded as they are
    expect(gate.length).toBe(cases.length);
  });
});
