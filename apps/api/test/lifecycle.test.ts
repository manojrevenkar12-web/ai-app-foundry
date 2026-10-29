import { loadBundleDir } from "@foundry/gate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, type Client, dropDatabase, faultModelStub, freshDatabase, persona, ROOT, type Server, startServer } from "./helpers.js";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let s: Server;
let stub: Awaited<ReturnType<typeof faultModelStub>>;
let mara: Client;
let jonas: Client;
let lea: Client;
let tomas: Client;
let sofia: Client;

type B = {
  manifest: Record<string, unknown> & { budget: Record<string, number>; connectors: Array<{ id: string }> };
  code: string;
  ui: unknown;
  tests: unknown[];
};
const example = (name: string) => structuredClone(loadBundleDir(`${ROOT}/examples/apps/${name}`)) as B;

beforeAll(async () => {
  db = await freshDatabase(400);
  stub = await faultModelStub();
  s = await startServer(db, {}, stub.url);
  [mara, jonas, lea, tomas, sofia] = await Promise.all(["mara", "jonas", "lea", "tomas", "sofia"].map((k) => as(s, k)));
});
afterAll(async () => {
  await s?.close();
  stub?.close();
  if (db) await dropDatabase(db.name);
});

const submit = async (who: Client, b: unknown) => who.post("/v1/apps", { bundle: b });
const publish = (who: Client, id: string, n: number) => who.post(`/v1/apps/${id}/versions/${n}/publish`);
const invoke = (who: Client, id: string, handler: string, input: unknown) => who.post(`/v1/apps/${id}/invoke`, { handler, input });

describe("a tier 0 app", () => {
  it("is approved by the gate, published by its owner and used by its audience", async () => {
    const r = await submit(mara, example("shift-handover"));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ app: "shift-handover", number: 1, status: "approved" });
    expect((await publish(mara, "shift-handover", 1)).body).toEqual({ live: 1 });
    const used = await invoke(jonas, "shift-handover", "tidy", { notes: "DE*EDR*E1001 tripped twice" });
    expect(used.status).toBe(200);
    expect(used.body.value).toMatchObject({ checklist: expect.stringContaining("DE\\*EDR\\*E1001") });
  });

  it("is not open to people outside its audience", async () => {
    expect((await invoke(lea, "shift-handover", "recent", {})).body.code).toBe("NOT_IN_AUDIENCE");
    expect((await lea.get("/v1/catalog")).body.some((a) => a.id === "shift-handover")).toBe(false);
    expect((await jonas.get("/v1/catalog")).body.some((a) => a.id === "shift-handover")).toBe(true);
  });

  it("keeps each viewer's private records to that viewer", async () => {
    await invoke(tomas, "shift-handover", "tidy", { notes: "PL charger offline" });
    const j = await invoke(jonas, "shift-handover", "recent", {});
    const t = await invoke(tomas, "shift-handover", "recent", {});
    expect((j.body.value as { rows: unknown[] }).rows).toHaveLength(1);
    expect((t.body.value as { rows: Array<{ checklist: string }> }).rows.map((x) => x.checklist).join()).toContain("PL charger");
    expect(JSON.stringify(t.body.value)).not.toContain("E1001");
  });

  it("validates input before the app sees it", async () => {
    const r = await invoke(jonas, "shift-handover", "tidy", { notes: "x", admin: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_INPUT");
  });
});

describe("a tier 2 app", () => {
  let hash = "";
  it("waits for a platform reviewer", async () => {
    const r = await submit(mara, example("fault-triage"));
    expect(r.body).toMatchObject({ status: "in_review" });
    hash = (r.body.report as { hash: string }).hash;
    expect((await publish(mara, "fault-triage", 1)).body.code).toBe("NOT_APPROVED");
  });

  it("cannot be approved by its author, by a non-reviewer, or for a different bundle", async () => {
    expect((await mara.post("/v1/apps/fault-triage/versions/1/decision", { decision: "approve", hash })).body.code).toBe("FOUR_EYES");
    expect((await sofia.post("/v1/apps/fault-triage/versions/1/decision", { decision: "approve", hash })).body.code).toBe(
      "REVIEWER_REQUIRED",
    );
    expect((await lea.post("/v1/apps/fault-triage/versions/1/decision", { decision: "approve", hash: "0".repeat(64) })).body.code).toBe(
      "HASH_MISMATCH",
    );
  });

  it("goes live after the reviewer approves the exact bundle", async () => {
    expect((await lea.get("/v1/reviews")).body.map((v) => v.app_id)).toContain("fault-triage");
    expect(
      (await lea.post("/v1/apps/fault-triage/versions/1/decision", { decision: "approve", hash, comment: "write path confirmed" })).body,
    ).toEqual({ status: "approved" });
    expect((await publish(mara, "fault-triage", 1)).body).toEqual({ live: 1 });
  });

  it("runs the model's tool calls as the viewer, in the viewer's countries", async () => {
    const de = await invoke(jonas, "fault-triage", "ask", { message: "Why is DE*EDR*E1001 faulted?" });
    expect(de.status).toBe(200);
    const reply = (de.body.value as { reply: string; sources: string[] }).reply;
    expect(reply).toContain("chargepoints.status");
    expect(reply).toMatch(/\*\*chargepoints\.status\*\*: DE\\\*EDR\\\*E1001 is \w+ at /);
    expect(reply).toContain("rcd_trip");
    // Tomáš sees Central Europe only: the same question finds nothing, and the model gets no data
    const cee = await invoke(tomas, "fault-triage", "ask", { message: "Why is DE*EDR*E1001 faulted?" });
    expect((cee.body.value as { reply: string }).reply).toContain("that you may see");
    expect((cee.body.value as { reply: string }).reply).not.toContain("rcd_trip");
  });

  it("holds a write until the viewer confirms it, once", async () => {
    const pool = new pg.Pool({ connectionString: db.ownerUrl });
    const ticket = (await pool.query(
      "select set_config('foundry.viewer_countries','*',false); select id from ev.tickets where country = 'DE' limit 1",
    )) as unknown as Array<{ rows: Array<{ id: string }> }>;
    const ticketId = ticket[1]?.rows[0]?.id as string;
    const r = await invoke(jonas, "fault-triage", "addTicketNote", { ticketId, note: "RCD module failed the test" });
    expect(r.status).toBe(202);
    const confirmation = r.body.confirmation as { id: string; summary: string };
    expect(confirmation.summary).toContain(ticketId);
    const before = await pool.query("select count(*)::int as n from ev.ticket_comments where ticket_id = $1", [ticketId]);
    expect(before.rows[0]?.n).toBe(0);
    expect((await tomas.post(`/v1/confirmations/${confirmation.id}`, { decision: "confirm" })).status).toBe(404);
    const ok = await jonas.post(`/v1/confirmations/${confirmation.id}`, { decision: "confirm" });
    expect(ok.body).toMatchObject({ done: true });
    const after = await pool.query("select author_name, via_app from ev.ticket_comments where ticket_id = $1", [ticketId]);
    expect(after.rows).toEqual([{ author_name: "Jonas Wagner", via_app: "fault-triage" }]);
    expect((await jonas.post(`/v1/confirmations/${confirmation.id}`, { decision: "confirm" })).body.code).toBe("ALREADY_USED");
    await pool.end();
  });

  it("refuses a confirmed write to a ticket the viewer may not see, and leaves the confirmation usable", async () => {
    const r = await invoke(jonas, "fault-triage", "addTicketNote", { ticketId: "T-9999999", note: "no such ticket" });
    expect(r.status).toBe(202);
    const id = (r.body.confirmation as { id: string }).id;
    const refused = await jonas.post(`/v1/confirmations/${id}`, { decision: "confirm" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("FORBIDDEN_FOR_VIEWER");
    // nothing was used up: the person can still cancel it
    expect((await jonas.post(`/v1/confirmations/${id}`, { decision: "cancel" })).body).toEqual({ cancelled: true });
  });

  it("needs a new review when the bundle changes, and can be rolled back", async () => {
    const b = example("fault-triage");
    b.code = b.code.replace("Never invent ticket numbers", "Never guess ticket numbers");
    const r = await submit(mara, b);
    expect(r.body).toMatchObject({ number: 2, status: "in_review" });
    const h2 = (r.body.report as { hash: string }).hash;
    expect(h2).not.toBe(hash);
    await lea.post("/v1/apps/fault-triage/versions/2/decision", { decision: "approve", hash: h2 });
    expect((await publish(mara, "fault-triage", 2)).body).toEqual({ live: 2 });
    expect((await publish(mara, "fault-triage", 1)).body).toEqual({ live: 1 });
    const versions = (await mara.get("/v1/apps/fault-triage")).body.versions as Array<{ number: number; status: string }>;
    expect(versions.map((v) => [v.number, v.status])).toEqual([
      [2, "superseded"],
      [1, "live"],
    ]);
  });
});

describe("what the runtime enforces whatever the gate saw", () => {
  it("refuses a connector the manifest does not declare, even when the code hides its name", async () => {
    const b = example("site-snapshot");
    b.code = b.code.replace(
      "export async function snapshot",
      'export async function peek(_, ctx) { return ctx.connectors.call(["sessions", "revenue"].join("."), {}) }\nexport async function snapshot',
    );
    (b.manifest.handlers as unknown[]).push({ name: "peek", input: { type: "object", properties: {} } });
    b.manifest.id = "snapshot-peek";
    const r = await submit(mara, b);
    expect(r.body.status).toBe("in_review"); // computed capability raises the tier
    await mara.post("/v1/apps/snapshot-peek/versions/1/decision", { decision: "approve", hash: (r.body.report as { hash: string }).hash });
    await lea.post("/v1/apps/snapshot-peek/versions/1/decision", { decision: "approve", hash: (r.body.report as { hash: string }).hash });
    await publish(mara, "snapshot-peek", 1);
    const out = await invoke(sofia, "snapshot-peek", "peek", {});
    expect(out.body.code).toBe("CAPABILITY_NOT_DECLARED");
  });

  it("refuses group-limited data to a viewer outside the group, inside an app that may use it", async () => {
    const r = await submit(sofia, example("revenue-brief"));
    await lea.post("/v1/apps/revenue-brief/versions/1/decision", { decision: "approve", hash: (r.body.report as { hash: string }).hash });
    await publish(sofia, "revenue-brief", 1);
    const own = await invoke(sofia, "revenue-brief", "brief", { country: "IT", months: 1 });
    expect(own.status).toBe(200);
    // Sofia sees Italy only: asking for Germany returns no rows, not Germany's revenue
    const de = await invoke(sofia, "revenue-brief", "brief", { country: "DE", months: 1 });
    expect((de.body.value as { rows: unknown[] }).rows).toEqual([]);
  });
});

describe("budgets and caching", () => {
  it("refuses model calls once the app's daily budget is spent", async () => {
    const b = example("shift-handover");
    b.manifest.id = "tiny-budget";
    // a worst-case reservation is about 2,800 micro-euros; actual calls cost about 400
    b.manifest.budget = { eurPerDay: 0.004, tokensPerUserPerDay: 100000 };
    const r = await submit(mara, b);
    await publish(mara, "tiny-budget", r.body.number as number);
    const codes: string[] = [];
    for (let i = 0; i < 6; i++)
      codes.push(((await invoke(jonas, "tiny-budget", "tidy", { notes: `note ${i} ${"x".repeat(200)}` })).body.code as string) ?? "ok");
    expect(codes[0]).toBe("ok");
    expect(codes).toContain("BUDGET_EXHAUSTED");
  });

  it("serves a repeated deterministic question from the cache without a provider call", async () => {
    const calls = async () => (await s.deps.metrics.providerCalls.get()).values.reduce((n, v) => n + v.value, 0);
    const sub = await submit(mara, example("site-snapshot"));
    await lea.post("/v1/apps/site-snapshot/versions/1/decision", { decision: "approve", hash: (sub.body.report as { hash: string }).hash });
    expect((await publish(mara, "site-snapshot", 1)).body).toEqual({ live: 1 });
    const a = await invoke(jonas, "site-snapshot", "snapshot", { country: "DE", city: "Essen" });
    expect(a.status).toBe(200);
    const before = await calls();
    const b = await invoke(jonas, "site-snapshot", "snapshot", { country: "DE", city: "Essen" });
    expect((b.body.usage as { cacheHits: number }).cacheHits).toBe(1);
    expect(await calls()).toBe(before);
  });

  it("never serves a tool-built answer to a viewer with other permissions", async () => {
    const q = { message: "Why is DE*EDR*E1001 faulted? (cache probe)" };
    const first = await invoke(jonas, "fault-triage", "ask", q);
    const sameScope = await invoke(mara, "fault-triage", "ask", q); // Europe-wide: a different scope
    expect((first.body.usage as { cacheHits: number }).cacheHits).toBe(0);
    expect((sameScope.body.usage as { cacheHits: number }).cacheHits).toBe(0);
    const tomasAnswer = await invoke(tomas, "fault-triage", "ask", q);
    expect((tomasAnswer.body.usage as { cacheHits: number }).cacheHits).toBe(0);
    expect((tomasAnswer.body.value as { reply: string }).reply).not.toContain("rcd_trip");
    const again = await invoke(jonas, "fault-triage", "ask", q);
    expect((again.body.usage as { cacheHits: number }).cacheHits).toBe(1);
  });
});

describe("data isolation in the database", () => {
  it("shows the runtime role no app records without an app and viewer, and none of another app's", async () => {
    const runtime = new pg.Client({ connectionString: db.runtimeUrl });
    await runtime.connect();
    expect((await runtime.query("select count(*)::int as n from foundry.app_records")).rows[0]?.n).toBe(0);
    await runtime.query("begin");
    await runtime.query("select set_config('foundry.app_id', 'site-snapshot', true), set_config('foundry.viewer_oid', $1, true)", [
      persona("jonas").oid,
    ]);
    expect((await runtime.query("select count(*)::int as n from foundry.app_records")).rows[0]?.n).toBe(0);
    await runtime.query("rollback");
    await runtime.query("begin");
    await runtime.query("select set_config('foundry.app_id', 'shift-handover', true), set_config('foundry.viewer_oid', $1, true)", [
      persona("jonas").oid,
    ]);
    expect((await runtime.query("select count(*)::int as n from foundry.app_records")).rows[0]?.n).toBe(1);
    await expect(
      runtime.query(
        "insert into foundry.app_records (app_id, collection, key, value, classification, expires_at) values ('fault-triage', 'x', 'k', '{}', 'internal', now() + interval '1 day')",
      ),
    ).rejects.toThrow(/row-level security/);
    await runtime.query("rollback");
    await runtime.end();
  });
});

describe("audit", () => {
  it("records decisions in a chain that verifies and cannot be edited", async () => {
    const v = await lea.get("/v1/audit/verify");
    if (!v.body.ok) {
      const dbg = new pg.Client({ connectionString: db.ownerUrl });
      await dbg.connect();
      const rows = (
        await dbg.query(
          "select seq, at, extract(epoch from at)*1000000 as micros, prev_hash, hash from foundry.audit where seq between $1::bigint - 1 and $1::bigint",
          [v.body.brokenAt],
        )
      ).rows;
      process.stderr.write(`BROKEN ${JSON.stringify(v.body)} ${JSON.stringify(rows)}\n`);
      await dbg.end();
    }
    expect(v.body).toMatchObject({ ok: true });
    expect((v.body.records as number) > 10).toBe(true);
    const listed = (await lea.get("/v1/audit?limit=500")).body;
    // newest first, by number: sorting the text form would put 9 before 10
    const seqs = listed.map((r) => Number(r.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    const actions = listed.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["version.submitted", "version.approved", "app.published", "app.rolled-back", "write.confirmed"]),
    );
    expect((await jonas.get("/v1/audit")).status).toBe(403);
    const owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
    await expect(owner.query("update foundry.audit set actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(owner.query("delete from foundry.audit")).rejects.toThrow(/append-only/);
    await owner.end();
  });
});
