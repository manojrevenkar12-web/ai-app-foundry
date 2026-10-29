import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, dropDatabase, freshDatabase, persona, type Server, startServer } from "./helpers.js";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let s: Server;
beforeAll(async () => {
  db = await freshDatabase(200);
  s = await startServer(db);
});
afterAll(async () => {
  await s?.close();
  if (db) await dropDatabase(db.name);
});

const me = (token: string) => s.app.request("/v1/me", { headers: { authorization: `Bearer ${token}` } });

describe("Entra access tokens", () => {
  it("become a principal keyed by oid, with roles and groups resolved from object ids", async () => {
    const jonas = await as(s, "jonas");
    const r = await jonas.get("/v1/me");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      oid: persona("jonas").oid,
      roles: ["Foundry.User"],
      groups: ["EDRI-All", "EDRI-Country-DE", "EDRI-Ops"],
      countries: ["DE"],
      groupsKnown: true,
    });
  });

  it("are refused when signed by someone else, for another audience, another tenant, or for an app", async () => {
    const dev = s.deps.dev;
    if (!dev) throw new Error("no dev idp");
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ oid: persona("lea").oid, tid: s.deps.directory.tenantId, roles: ["Foundry.Admin"] })
      .setProtectedHeader({ alg: "RS256", kid: "dev-1" })
      .setIssuer(dev.issuer)
      .setAudience(s.deps.directory.audience)
      .setExpirationTime("1h")
      .sign(privateKey);
    expect((await me(forged)).status).toBe(401);
    expect((await me(await dev.accessToken(persona("lea"), { aud: "api://someone-else" }))).status).toBe(401);
    expect((await me(await dev.accessToken(persona("lea"), { tid: "00000000-0000-0000-0000-000000000000" }))).status).toBe(401);
    expect((await me(await dev.accessToken(persona("lea"), { idtyp: "app" }))).status).toBe(401);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ oid: "x", tid: s.deps.directory.tenantId, aud: s.deps.directory.audience, iss: dev.issuer })).toString("base64url")}.`;
    expect((await me(none)).status).toBe(401);
  });

  it("resolve groups through Graph when the token's groups claim overflowed", async () => {
    const r = await (await as(s, "sofia")).get("/v1/me");
    expect(r.body).toMatchObject({ groups: ["EDRI-All", "EDRI-Commercial", "EDRI-Country-IT"], countries: ["IT"], groupsKnown: true });
  });

  it("fail closed when Graph cannot be reached: no groups, no group-limited data", async () => {
    const dev = s.deps.dev;
    if (!dev) throw new Error("no dev idp");
    dev.state.graphDown = true;
    try {
      const r = await (await as(s, "sofia")).get("/v1/me");
      expect(r.body).toMatchObject({ groups: [], countries: [], groupsKnown: false });
    } finally {
      dev.state.graphDown = false;
    }
  });
});

describe("browser sign-in", () => {
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const signIn = async (hint: string, returnTo = "/apps") => {
    const start = await s.app.request(`/auth/login?login_hint=${hint}&returnTo=${encodeURIComponent(returnTo)}`);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location") ?? "");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const idp = await s.app.request(authorize.pathname + authorize.search);
    const callback = new URL(idp.headers.get("location") ?? "");
    const done = await s.app.request(callback.pathname + callback.search);
    return { done, callback };
  };

  it("runs the code flow with PKCE and sets an HttpOnly session cookie, never a token", async () => {
    const { done } = await signIn("jonas");
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("http://console.test/apps");
    const set = done.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    const r = await s.app.request("/v1/me", { headers: { cookie: cookieOf(done) } });
    expect(((await r.json()) as { oid: string }).oid).toBe(persona("jonas").oid);
  });

  it("refuses a replayed callback", async () => {
    const { callback } = await signIn("jonas");
    const again = await s.app.request(callback.pathname + callback.search);
    expect(again.status).toBe(400);
  });

  it("does not redirect to another site after sign-in", async () => {
    const { done } = await signIn("jonas", "//evil.example/x");
    expect(done.headers.get("location")).toBe("http://console.test/");
  });

  it("requires the request header for changes made with a cookie", async () => {
    const { done } = await signIn("mara");
    const cookie = cookieOf(done);
    const without = await s.app.request("/v1/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: ["apps:read"], days: 1 }),
    });
    expect(without.status).toBe(403);
    const withHeader = await s.app.request("/v1/tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-foundry-request": "1" },
      body: JSON.stringify({ name: "x", scopes: ["apps:read"], days: 1 }),
    });
    expect(withHeader.status).toBe(201);
  });
});

describe("personal access tokens", () => {
  it("act as their owner, only within their scopes, until revoked", async () => {
    const { done } = await (async () => {
      const start = await s.app.request("/auth/login?login_hint=mara");
      const a = new URL(start.headers.get("location") ?? "");
      const cb = new URL((await s.app.request(a.pathname + a.search)).headers.get("location") ?? "");
      return { done: await s.app.request(cb.pathname + cb.search) };
    })();
    const cookie = (done.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const made = await s.app.request("/v1/tokens", {
      method: "POST",
      headers: { cookie, "x-foundry-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ name: "claude code", scopes: ["apps:read"], days: 7 }),
    });
    const { token, id } = (await made.json()) as { token: string; id: string };
    expect(token).toMatch(/^fdy_/);
    const auth = { authorization: `Bearer ${token}` };
    expect(((await (await s.app.request("/v1/me", { headers: auth })).json()) as { name: string }).name).toBe("Mara Becker");
    expect(
      (await s.app.request("/v1/check", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(403);
    // a token cannot mint more tokens
    expect(
      (
        await s.app.request("/v1/tokens", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ name: "y", scopes: ["apps:write"], days: 30 }),
        })
      ).status,
    ).toBe(403);
    await s.app.request(`/v1/tokens/${id}`, { method: "DELETE", headers: { cookie, "x-foundry-request": "1" } });
    expect((await s.app.request("/v1/me", { headers: auth })).status).toBe(401);
  });
});
