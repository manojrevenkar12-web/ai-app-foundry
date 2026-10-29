/**
 * Serving an app. For each invocation: the viewer must be in the app's audience and under the
 * rate limit, the input must match the handler's schema, and the handler runs in a fresh sandbox
 * whose every platform call is checked against the manifest (the same rules as the gate) and then
 * performed as the viewer: connectors in the viewer's scope, models within the app's budget, data
 * in the app's and viewer's rows. A write the app wants is held until the viewer confirms it.
 */
import { type Bundle, type ErrorCode, toZod } from "@foundry/contract";
import { type Catalog, checkCall, checkConfirm } from "@foundry/gate";
import { type Host, HostError, runHandler } from "@foundry/sandbox";
import { ulid } from "ulid";
import type { Audit } from "../audit/audit.js";
import type { Connectors } from "../connectors/registry.js";
import { mayUse } from "../connectors/registry.js";
import type { Pool } from "../db/pool.js";
import { tx } from "../db/scope.js";
import type { ChatInput, Gateway } from "../gateway/gateway.js";
import type { Limits } from "../gateway/limits.js";
import { conflict, forbidden, notFound, Problem, STATUS_OF } from "../http/problem.js";
import type { Principal } from "../identity/principal.js";
import { inAudience, type Registry } from "../registry/registry.js";
import type { Store } from "./store.js";

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  costMicroEur: number;
  cacheHits: number;
}

export type Result =
  | { kind: "value"; value: unknown; usage: Usage; ms: number }
  | {
      kind: "stream";
      events: AsyncIterable<
        { type: "text"; text: string } | { type: "done"; usage: { inputTokens: number; outputTokens: number }; costMicroEur?: number }
      >;
      usage: Usage;
    }
  | {
      kind: "confirm";
      confirmation: { id: string; summary: string; connector: string; title: string; args: Record<string, unknown>; expiresAt: string };
      usage: Usage;
    };

export interface RuntimeDeps {
  pool: Pool;
  registry: Registry;
  catalog: Catalog;
  connectors: Connectors;
  gateway: Gateway;
  store: Store;
  limits: Limits;
  audit: Audit;
  perMinute: number;
  onInvocation?: (appId: string, outcome: string, seconds: number) => void;
}

const CONFIRM_TTL_MS = 10 * 60_000;

/** Versions never change, so a loaded bundle can be kept for as long as memory allows. */
const bundles = new Map<string, Bundle>();
const remember = (key: string, b: Bundle) => {
  if (bundles.size > 500) bundles.delete(bundles.keys().next().value as string);
  bundles.set(key, b);
};

export const createRuntime = (d: RuntimeDeps) => {
  const liveBundle = async (appId: string, p: Principal) => {
    const a = await d.registry.app(appId);
    if (!a || a.tid !== p.tid) throw notFound(`app ${appId}`);
    if (a.status !== "live" || !a.live_version) throw new Problem(404, "NOT_LIVE", `${a.name} is not live`);
    const key = `${appId}@${a.live_version}`;
    let b = bundles.get(key);
    if (!b) {
      const v = await d.registry.version(appId, a.live_version);
      if (!v) throw notFound(key);
      b = v.bundle;
      remember(key, b);
    }
    if (!inAudience(b.manifest.audience, a.owner_oid, p)) throw forbidden("NOT_IN_AUDIENCE", `${a.name} is not shared with you`);
    return { bundle: b, number: a.live_version };
  };

  const invoke = async (o: {
    viewer: Principal;
    appId: string;
    handler: string;
    input: unknown;
    signal: AbortSignal;
    preview?: Bundle;
  }): Promise<Result> => {
    const t0 = performance.now();
    const p = o.viewer;
    const { bundle, number } = o.preview ? { bundle: o.preview, number: 0 } : await liveBundle(o.appId, p);
    const m = bundle.manifest;
    // a preview keeps its own data and budget, apart from the live app's
    const scopeId = o.preview ? `preview:${m.id}:${p.oid}` : m.id;
    const h = m.handlers.find((x) => x.name === o.handler);
    if (!h) throw new Problem(404, "UNKNOWN_HANDLER", `${m.name} has no handler ${o.handler}`);
    const parsed = toZod(h.input).safeParse(o.input ?? {});
    if (!parsed.success)
      throw new Problem(400, "INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    if (!(await d.limits.allow(scopeId, p.oid, d.perMinute)))
      throw new Problem(429, "RATE_LIMITED", `at most ${d.perMinute} calls a minute to one app`);

    const usage: Usage = { tokensIn: 0, tokensOut: 0, costMicroEur: 0, cacheHits: 0 };
    const streams = new Map<string, ChatInput>();
    const budget = { appId: scopeId, eurPerDay: m.budget.eurPerDay, tokensPerUserPerDay: m.budget.tokensPerUserPerDay };

    const host: Host = async (op, payload, signal) => {
      const call = checkCall(m, d.catalog, op, payload);
      switch (call.op) {
        case "connector":
          return d.connectors.call(call.id, call.args, { viewer: p, appId: scopeId, signal });
        case "llm.chat": {
          const out = await d.gateway.chat({
            app: budget,
            viewer: p,
            alias: call.alias,
            ...(call.system ? { system: call.system } : {}),
            messages: call.messages,
            maxTokens: call.maxTokens,
            temperature: call.temperature,
            tools: call.tools,
            signal,
          });
          usage.tokensIn += out.usage.inputTokens;
          usage.tokensOut += out.usage.outputTokens;
          usage.costMicroEur += out.costMicroEur;
          if (out.cacheHit) usage.cacheHits += 1;
          return { text: out.text, usage: out.usage, toolCalls: out.toolCalls };
        }
        case "llm.stream": {
          const id = ulid();
          streams.set(id, {
            app: budget,
            viewer: p,
            alias: call.alias,
            ...(call.system ? { system: call.system } : {}),
            messages: call.messages,
            maxTokens: call.maxTokens,
            temperature: call.temperature,
            tools: [],
            signal: o.signal,
          });
          return { id };
        }
        default: {
          const col = m.collections.find((c) => c.name === call.collection);
          if (!col) throw new HostError("CAPABILITY_NOT_DECLARED", `collection ${call.collection} is not declared`);
          if (call.op === "store.put") return d.store.put(scopeId, p.oid, col, call.key, call.value);
          if (call.op === "store.list") return d.store.list(scopeId, p.oid, col, call.prefix, call.limit);
          return call.op === "store.get" ? d.store.get(scopeId, p.oid, col, call.key) : d.store.delete(scopeId, p.oid, col, call.key);
        }
      }
    };

    const facts = {
      app: m.id,
      version: number,
      user: { name: p.name, roles: p.roles, groups: p.groups },
      now: new Date().toISOString(),
    };
    const out = await runHandler({ code: bundle.code, handler: h.name, input: parsed.data, context: facts, host });
    const record = async (ok: boolean, code: string | null) => {
      d.onInvocation?.(m.id, ok ? "ok" : (code ?? "error"), (performance.now() - t0) / 1000);
      await d.pool
        .query(
          `insert into foundry.invocations (app_id, number, tid, viewer_oid, handler, ok, error_code, wall_ms, cpu_ms, host_calls, tokens_in, tokens_out, cost_micro_eur, cache_hits)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            scopeId,
            number,
            p.tid,
            p.oid,
            h.name,
            ok,
            code,
            Math.round(out.stats.wallMs),
            Math.round(out.stats.cpuMs),
            out.stats.hostCalls,
            usage.tokensIn,
            usage.tokensOut,
            Math.round(usage.costMicroEur),
            usage.cacheHits,
          ],
        )
        .catch(() => undefined);
    };
    if (!out.ok) {
      await record(false, out.error?.code ?? "APP_ERROR");
      const code = (out.error?.code ?? "APP_ERROR") as ErrorCode;
      throw new Problem(STATUS_OF[code] ?? 422, code, out.error?.message ?? "the app failed", { logs: o.preview ? out.logs : undefined });
    }
    await record(true, null);

    if (out.directive?.kind === "stream") {
      const input = streams.get(out.directive.id);
      if (!input) throw new Problem(422, "APP_ERROR", "the app returned a stream it did not open");
      return { kind: "stream", events: d.gateway.stream(input), usage };
    }
    if (out.directive?.kind === "confirm") {
      if (o.preview)
        throw new Problem(409, "CONFIRMATION_REQUIRED", "previews cannot change data in other systems; publish the app to use this");
      const c = checkConfirm(m, d.catalog, out.directive.request);
      const may = mayUse(c.def, p);
      if (!may.ok) throw forbidden("FORBIDDEN_FOR_VIEWER", may.reason);
      const id = ulid();
      const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS);
      await d.pool.query(
        "insert into foundry.confirmations (id, app_id, number, tid, viewer_oid, connector, args, summary, expires_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [id, m.id, number, p.tid, p.oid, c.id, JSON.stringify(c.args), c.summary, expiresAt],
      );
      return {
        kind: "confirm",
        confirmation: { id, summary: c.summary, connector: c.id, title: c.def.title, args: c.args, expiresAt: expiresAt.toISOString() },
        usage,
      };
    }
    return { kind: "value", value: out.value, usage, ms: Math.round(performance.now() - t0) };
  };

  return {
    invoke,

    /** The viewer confirms (or cancels) a write an app asked for. One use, ten minutes. */
    async confirm(p: Principal, id: string, decision: "confirm" | "cancel") {
      return tx(d.pool, async (c) => {
        const row = (
          await c.query<{
            app_id: string;
            number: number;
            tid: string;
            viewer_oid: string;
            connector: string;
            args: Record<string, unknown>;
            summary: string;
            expires_at: Date;
            used_at: Date | null;
          }>("select * from foundry.confirmations where id = $1 for update", [id])
        ).rows[0];
        if (!row || row.tid !== p.tid || row.viewer_oid !== p.oid) throw notFound("confirmation");
        if (row.used_at) throw conflict("ALREADY_USED", "this confirmation was already used");
        if (row.expires_at.getTime() < Date.now()) throw conflict("EXPIRED", "this confirmation has expired; run the action again");
        const a = await d.registry.app(row.app_id);
        if (a?.status !== "live") throw conflict("NOT_LIVE", "the app is no longer live");
        if (decision === "cancel") {
          await c.query("update foundry.confirmations set used_at = now(), outcome = $2 where id = $1", [
            id,
            JSON.stringify({ cancelled: true }),
          ]);
          return { cancelled: true };
        }
        const result = await d.connectors.call(row.connector, row.args, {
          viewer: p,
          appId: row.app_id,
          signal: AbortSignal.timeout(15_000),
        });
        await c.query("update foundry.confirmations set used_at = now(), outcome = $2 where id = $1", [id, JSON.stringify(result)]);
        await d.audit.append(c, {
          tid: p.tid,
          actor: p.oid,
          action: "write.confirmed",
          target: `${row.app_id}@${row.number}`,
          detail: { connector: row.connector, summary: row.summary },
        });
        return { done: true, result };
      });
    },
  };
};
export type Runtime = ReturnType<typeof createRuntime>;
