/**
 * The HTTP surface. Three ways in: the console's session cookie (sign-in through Entra, run by
 * this API), a personal access token (AI coding tools, scripts), or an Entra access token issued
 * for this API (other services). Mutations through a cookie must carry x-foundry-request, which a
 * cross-site form cannot send.
 */
import { randomUUID } from "node:crypto";
import { Bundle } from "@foundry/contract";
import type { Catalog } from "@foundry/gate";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Audit } from "../audit/audit.js";
import type { Builder } from "../builder/builder.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import { PERSONAS } from "../identity/dev-idp.js";
import { has, type Principal, type Role } from "../identity/principal.js";
import { COOKIE, SESSION_TTL_S, type Sessions, safeReturnTo } from "../identity/sessions.js";
import { SCOPES, type Tokens } from "../identity/tokens.js";
import type { Metrics } from "../ops/metrics.js";
import { appUsage, overview } from "../ops/usage.js";
import type { RedisClient } from "../redis.js";
import type { Registry } from "../registry/registry.js";
import type { Runtime } from "../runtime/runtime.js";
import { forbidden, invalid, notFound, Problem } from "./problem.js";

export interface HttpDeps {
  config: Config;
  pool: Pool;
  redis: RedisClient;
  catalog: Catalog;
  registry: Registry;
  runtime: Runtime;
  audit: Audit;
  sessions: Sessions;
  tokens: Tokens;
  builder: Builder;
  metrics: Metrics;
  validateEntraToken: (token: string) => Promise<Principal>;
  devIdp?: Hono;
  /** the identity provider's endpoints, for the sign-in redirect and the code exchange */
  idp: { authorize: string; token: string; exchange: (form: URLSearchParams) => Promise<Response> };
}

type Env = { Variables: { principal: Principal; requestId: string } };

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw invalid(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};
const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

export const createHttp = (d: HttpDeps) => {
  const app = new Hono<Env>();
  const secure = d.config.PUBLIC_URL.startsWith("https://");
  const cookieName = COOKIE(secure);

  app.use("*", async (c, next) => {
    const id = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", id);
    c.header("x-request-id", id);
    const t0 = performance.now();
    await next();
    d.metrics.http.observe({ method: c.req.method, route: c.req.routePath, status: String(c.res.status) }, (performance.now() - t0) / 1000);
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      crossOriginResourcePolicy: "same-origin",
    }),
  );

  app.onError((e, c) => {
    if (e instanceof Problem)
      return c.json(
        {
          type: `https://foundry.edri.example/problems/${e.code.toLowerCase()}`,
          title: e.message,
          status: e.status,
          code: e.code,
          ...e.extra,
        },
        e.status as 400,
      );
    console.error(
      JSON.stringify({
        level: "error",
        requestId: c.get("requestId"),
        message: (e as Error).message,
        stack: (e as Error).stack?.split("\n").slice(0, 4),
      }),
    );
    return c.json(
      {
        type: "https://foundry.edri.example/problems/internal",
        title: "internal error",
        status: 500,
        code: "INTERNAL",
        requestId: c.get("requestId"),
      },
      500,
    );
  });

  // ---- health and metrics -----------------------------------------------------------
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", async (c) => {
    await d.pool.query("select 1");
    await d.redis.ping();
    return c.json({ status: "ready" });
  });
  app.get("/metrics", async (c) => c.text(await d.metrics.registry.metrics(), 200, { "content-type": d.metrics.registry.contentType }));

  if (d.devIdp) app.route("/dev-idp", d.devIdp);

  // ---- sign-in (backend for frontend) -----------------------------------------------
  app.get("/auth/login", async (c) => {
    const { state, nonce, challenge } = await d.sessions.begin(safeReturnTo(c.req.query("returnTo")));
    const url = new URL(d.idp.authorize);
    url.search = new URLSearchParams({
      client_id: d.config.ENTRA_CLIENT_ID,
      response_type: "code",
      redirect_uri: `${d.config.PUBLIC_URL}/auth/callback`,
      response_mode: "query",
      scope: `openid profile offline_access api://${d.config.ENTRA_CLIENT_ID}/access_as_user`,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(c.req.query("login_hint") ? { login_hint: c.req.query("login_hint") as string } : {}),
    }).toString();
    return c.redirect(url.toString(), 302);
  });

  app.get("/auth/callback", async (c) => {
    const pending = await d.sessions.finish(c.req.query("state") ?? "");
    if (!pending) throw new Problem(400, "SIGN_IN_EXPIRED", "the sign-in took too long or was already used; start again");
    const res = await d.idp.exchange(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: c.req.query("code") ?? "",
        redirect_uri: `${d.config.PUBLIC_URL}/auth/callback`,
        client_id: d.config.ENTRA_CLIENT_ID,
        client_secret: d.config.ENTRA_CLIENT_SECRET ?? "",
        code_verifier: pending.verifier,
      }),
    );
    if (!res.ok) throw new Problem(401, "SIGN_IN_FAILED", "the identity provider refused the sign-in");
    const tokens = (await res.json()) as { access_token: string; id_token: string };
    const principal = await d.validateEntraToken(tokens.access_token);
    await d.pool.query(
      "insert into foundry.people (tid, oid, name) values ($1, $2, $3) on conflict (tid, oid) do update set name = excluded.name, last_seen = now()",
      [principal.tid, principal.oid, principal.name],
    );
    const sid = await d.sessions.create(principal);
    setCookie(c, cookieName, sid, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_S });
    await d.audit.record({
      tid: principal.tid,
      actor: principal.oid,
      action: "signed-in",
      target: principal.oid,
      detail: { groupsKnown: principal.groupsKnown },
    });
    return c.redirect(`${d.config.CONSOLE_URL}${pending.returnTo}`, 302);
  });

  app.post("/auth/logout", async (c) => {
    const sid = getCookie(c, cookieName);
    if (sid) await d.sessions.destroy(sid);
    deleteCookie(c, cookieName, { path: "/", secure });
    return c.json({ ok: true });
  });

  app.get("/auth/personas", (c) =>
    d.devIdp ? c.json(PERSONAS.map(({ key, name, title, roles, groups }) => ({ key, name, title, roles, groups }))) : c.json([], 404),
  );

  // ---- authentication for /v1 ---------------------------------------------------------
  app.use("/v1/*", async (c, next) => {
    const auth = c.req.header("authorization");
    let p: Principal | null = null;
    if (auth?.startsWith("Bearer fdy_")) p = await d.tokens.resolve(auth.slice(7));
    else if (auth?.startsWith("Bearer ")) p = await d.validateEntraToken(auth.slice(7)).catch(() => null);
    else {
      const sid = getCookie(c, cookieName);
      p = sid ? await d.sessions.get(sid) : null;
      if (p && c.req.method !== "GET" && c.req.header("x-foundry-request") !== "1")
        throw forbidden("CSRF", "requests that change something need the x-foundry-request header");
    }
    if (!p) throw new Problem(401, "UNAUTHENTICATED", "sign in, or send a valid token");
    c.set("principal", p);
    await next();
  });

  const who = (c: { get: (k: "principal") => Principal }) => c.get("principal");
  const need = (p: Principal, ...roles: Role[]) => {
    if (!has(p, ...roles)) throw forbidden("ROLE_REQUIRED", `needs one of ${roles.join(", ")}`);
  };
  const scope = (p: Principal, s: (typeof SCOPES)[number]) => {
    if (p.via === "token" && p.scopes && !p.scopes.includes(s)) throw forbidden("SCOPE_REQUIRED", `this token lacks ${s}`);
  };

  app.get("/v1/me", (c) => {
    const p = who(c);
    return c.json({
      oid: p.oid,
      name: p.name,
      roles: p.roles,
      groups: p.groups,
      countries: p.countries,
      groupsKnown: p.groupsKnown,
      via: p.via,
    });
  });

  /** What builders (and their AI coding tools) can use. */
  app.get("/v1/platform", (c) =>
    c.json({
      connectors: d.catalog.connectors.map(({ example: _e, ...rest }) => rest),
      models: d.catalog.models.map((m) => ({ alias: m.alias, eurPerMillionIn: m.eurPerMillionIn, eurPerMillionOut: m.eurPerMillionOut })),
      limits: { cpuMs: 250, memoryMiB: 32, wallSeconds: 30, platformCalls: 64, resultBytes: 1_000_000 },
      builder: d.builder.generator,
    }),
  );

  // ---- catalog, apps, versions, review ------------------------------------------------
  app.get("/v1/catalog", async (c) => {
    scope(who(c), "apps:read");
    return c.json(await d.registry.catalogFor(who(c)));
  });

  app.get("/v1/apps/:id", async (c) => {
    const p = who(c);
    scope(p, "apps:read");
    const a = await d.registry.app(c.req.param("id"));
    if (!a || a.tid !== p.tid) throw notFound("app");
    const mine = a.owner_oid === p.oid;
    const live = a.live_version ? await d.registry.version(a.id, a.live_version) : undefined;
    if (!mine && !has(p, "Foundry.Reviewer", "Foundry.Admin")) {
      // people who only use the app see what they need to use it
      const visible = (await d.registry.catalogFor(p)).some((x) => x.id === a.id);
      if (!visible || !live) throw notFound("app");
      return c.json({
        id: a.id,
        name: a.name,
        description: a.description,
        owner: a.owner_name,
        status: a.status,
        live: { number: live.number, ui: live.bundle.ui, handlers: live.bundle.manifest.handlers },
      });
    }
    return c.json({
      id: a.id,
      name: a.name,
      description: a.description,
      owner: a.owner_name,
      mine,
      status: a.status,
      live: live
        ? {
            number: live.number,
            ui: live.bundle.ui,
            handlers: live.bundle.manifest.handlers,
            manifest: live.bundle.manifest,
            tier: live.tier,
          }
        : null,
      versions: await d.registry.versions(a.id),
    });
  });

  app.get("/v1/apps/:id/versions/:n", async (c) => {
    const p = who(c);
    scope(p, "apps:read");
    const a = await d.registry.app(c.req.param("id"));
    const v = a ? await d.registry.version(a.id, Number(c.req.param("n"))) : undefined;
    if (!a || !v || a.tid !== p.tid) throw notFound("version");
    if (a.owner_oid !== p.oid && !has(p, "Foundry.Builder", "Foundry.Reviewer", "Foundry.Admin")) throw notFound("version");
    const previous = a.live_version && a.live_version !== v.number ? await d.registry.version(a.id, a.live_version) : undefined;
    return c.json({
      ...v,
      liveBundle: previous?.bundle ?? null,
      decisions: (await d.registry.versions(a.id)).find((x) => x.number === v.number)?.decisions ?? [],
    });
  });

  app.post("/v1/check", async (c) => {
    scope(who(c), "apps:write");
    need(who(c), "Foundry.Builder");
    return c.json(await d.registry.check(await body(c)));
  });

  app.post("/v1/apps", async (c) => {
    scope(who(c), "apps:write");
    const b = (await body(c)) as { bundle?: unknown };
    return c.json(await d.registry.submit(who(c), b.bundle ?? b), 201);
  });

  const Decision = z.object({
    decision: z.enum(["approve", "reject"]),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    comment: z.string().max(2000).default(""),
  });
  app.post("/v1/apps/:id/versions/:n/decision", async (c) => {
    scope(who(c), "apps:write");
    const b = parse(Decision, await body(c));
    return c.json(await d.registry.decide(who(c), c.req.param("id"), Number(c.req.param("n")), b.decision, b.hash, b.comment));
  });

  app.post("/v1/apps/:id/versions/:n/publish", async (c) => {
    scope(who(c), "apps:write");
    return c.json(await d.registry.publish(who(c), c.req.param("id"), Number(c.req.param("n"))));
  });

  app.post("/v1/apps/:id/disable", async (c) => {
    scope(who(c), "apps:write");
    const b = parse(z.object({ reason: z.string().min(3).max(300) }), await body(c));
    return c.json(await d.registry.disable(who(c), c.req.param("id"), b.reason));
  });

  app.get("/v1/reviews", async (c) => c.json(await d.registry.reviewQueue(who(c))));

  // ---- running apps -----------------------------------------------------------------
  const Invoke = z.object({ handler: z.string().max(40), input: z.unknown() });
  const respond = (c: Context<Env>, r: Awaited<ReturnType<Runtime["invoke"]>>) => {
    if (r.kind === "stream")
      return streamSSE(c, async (s) => {
        try {
          for await (const ev of r.events) await s.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        } catch (e) {
          const code = e instanceof Problem ? e.code : ((e as { code?: string }).code ?? "UPSTREAM_ERROR");
          await s.writeSSE({ event: "error", data: JSON.stringify({ code, message: (e as Error).message }) });
        }
      });
    if (r.kind === "confirm") return c.json({ confirmation: r.confirmation, usage: r.usage }, 202);
    return c.json({ value: r.value, usage: r.usage, ms: r.ms });
  };

  app.post("/v1/apps/:id/invoke", async (c) => {
    const p = who(c);
    scope(p, "apps:invoke");
    const b = parse(Invoke, await body(c));
    const r = await d.runtime.invoke({ viewer: p, appId: c.req.param("id"), handler: b.handler, input: b.input, signal: c.req.raw.signal });
    return respond(c, r);
  });

  app.post("/v1/preview", async (c) => {
    const p = who(c);
    scope(p, "apps:write");
    need(p, "Foundry.Builder");
    const b = parse(z.object({ bundle: z.unknown(), handler: z.string(), input: z.unknown() }), await body(c));
    const bundle = Bundle.safeParse(b.bundle);
    if (!bundle.success) throw invalid("the bundle is not valid; run the check first");
    const existing = await d.registry.app(bundle.data.manifest.id);
    if (existing && existing.owner_oid !== p.oid) throw forbidden("NOT_OWNER", `${existing.id} belongs to ${existing.owner_name}`);
    const r = await d.runtime.invoke({
      viewer: p,
      appId: bundle.data.manifest.id,
      handler: b.handler,
      input: b.input,
      signal: c.req.raw.signal,
      preview: bundle.data,
    });
    return respond(c, r);
  });

  app.post("/v1/confirmations/:id", async (c) => {
    scope(who(c), "apps:invoke");
    const b = parse(z.object({ decision: z.enum(["confirm", "cancel"]) }), await body(c));
    return c.json(await d.runtime.confirm(who(c), c.req.param("id"), b.decision));
  });

  // ---- building with AI ----------------------------------------------------------------
  app.post("/v1/builder/draft", async (c) => {
    const p = who(c);
    scope(p, "apps:write");
    need(p, "Foundry.Builder");
    const b = parse(z.object({ description: z.string().min(10).max(2000) }), await body(c));
    return c.json(await d.builder.draft(b.description, p.groups));
  });

  // ---- tokens for AI coding tools -----------------------------------------------------
  app.get("/v1/tokens", async (c) => c.json(await d.tokens.list(who(c))));
  app.post("/v1/tokens", async (c) => {
    const p = who(c);
    if (p.via !== "session") throw forbidden("SESSION_REQUIRED", "tokens are made from a signed-in session");
    const b = parse(
      z.object({ name: z.string().min(1).max(80), scopes: z.array(z.enum(SCOPES)).min(1), days: z.number().int().min(1).max(30) }),
      await body(c),
    );
    const t = await d.tokens.issue(p, b.name, b.scopes, b.days);
    await d.audit.record({
      tid: p.tid,
      actor: p.oid,
      action: "token.issued",
      target: t.id,
      detail: { name: b.name, scopes: b.scopes, days: b.days },
    });
    return c.json(t, 201);
  });
  app.delete("/v1/tokens/:id", async (c) => {
    const ok = await d.tokens.revoke(who(c), c.req.param("id"));
    if (!ok) throw notFound("token");
    return c.json({ revoked: true });
  });

  // ---- operations and audit -------------------------------------------------------------
  app.get("/v1/apps/:id/usage", async (c) => {
    const p = who(c);
    const a = await d.registry.app(c.req.param("id"));
    if (!a || a.tid !== p.tid || (a.owner_oid !== p.oid && !has(p, "Foundry.Reviewer", "Foundry.Admin"))) throw notFound("app");
    return c.json(await appUsage(d.pool, a.id, Number(c.req.query("days") ?? 14)));
  });
  app.get("/v1/ops/overview", async (c) => {
    need(who(c), "Foundry.Admin", "Foundry.Reviewer");
    return c.json(await overview(d.pool));
  });
  app.get("/v1/audit", async (c) => {
    need(who(c), "Foundry.Admin");
    return c.json(await d.audit.list(Number(c.req.query("limit") ?? 200), c.req.query("target")));
  });
  app.get("/v1/audit/verify", async (c) => {
    need(who(c), "Foundry.Admin");
    return c.json(await d.audit.verify());
  });

  return app;
};
