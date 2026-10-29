/**
 * A stand-in for Entra ID in development and tests. It serves Entra's endpoint paths and token
 * shapes (v2.0 issuer, oid/tid, app roles, group object ids, groups overage) so the code that
 * validates real Entra tokens is the code that runs here. Refused in production by config.
 */
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import type { Directory } from "./directory.js";
import { issuerOf } from "./entra.js";
import type { Role } from "./principal.js";

export interface Persona {
  key: string;
  oid: string;
  name: string;
  title: string;
  roles: Role[];
  groups: string[];
  /** emit the overage marker instead of the groups claim, as Entra does past 200 groups */
  overage?: boolean;
}

export const PERSONAS: Persona[] = [
  {
    key: "mara",
    oid: "11111111-aaaa-4bbb-8ccc-000000000001",
    name: "Mara Becker",
    title: "Data scientist, AI unit",
    roles: ["Foundry.User", "Foundry.Builder"],
    groups: ["EDRI-All", "EDRI-Ops", "EDRI-Region-Europe"],
  },
  {
    key: "jonas",
    oid: "11111111-aaaa-4bbb-8ccc-000000000002",
    name: "Jonas Wagner",
    title: "Field operations, Germany",
    roles: ["Foundry.User"],
    groups: ["EDRI-All", "EDRI-Ops", "EDRI-Country-DE"],
  },
  {
    key: "lea",
    oid: "11111111-aaaa-4bbb-8ccc-000000000003",
    name: "Lea Hoffmann",
    title: "Platform reviewer, security",
    roles: ["Foundry.User", "Foundry.Builder", "Foundry.Reviewer", "Foundry.Admin"],
    groups: ["EDRI-All", "EDRI-Region-Europe"],
  },
  {
    key: "sofia",
    oid: "11111111-aaaa-4bbb-8ccc-000000000004",
    name: "Sofia Rossi",
    title: "Commercial analyst, Italy",
    roles: ["Foundry.User", "Foundry.Builder"],
    groups: ["EDRI-All", "EDRI-Commercial", "EDRI-Country-IT"],
    overage: true,
  },
  {
    key: "tomas",
    oid: "11111111-aaaa-4bbb-8ccc-000000000005",
    name: "Tomáš Novák",
    title: "Operations, Central Europe",
    roles: ["Foundry.User"],
    groups: ["EDRI-All", "EDRI-Ops", "EDRI-Country-CEE"],
  },
];

interface Code {
  persona: Persona;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
}

export const createDevIdp = async (o: {
  authority: string;
  tenantId: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  directory: Directory;
}) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "dev-1", use: "sig", alg: "RS256" };
  const codes = new Map<string, Code>();
  // Graph can be made to fail, to test that group-gated access fails closed
  const state = { graphDown: false };
  const idByName = new Map(o.directory.groups.map((g) => [g.name, g.id]));
  const issuer = issuerOf(o.authority, o.tenantId);
  const t = o.tenantId;

  /** overrides apply last, so tests can mint tokens for another tenant or audience */
  const sign = (claims: Record<string, unknown>, aud: string, overrides: Record<string, unknown> = {}) =>
    new SignJWT({ ver: "2.0", tid: t, ...claims, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "dev-1", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(typeof overrides.aud === "string" ? overrides.aud : aud)
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("1h")
      .sign(privateKey);

  /** An access token for this API, shaped like Entra's. */
  const accessToken = (p: Persona, extra: Record<string, unknown> = {}) => {
    const groups = p.groups.map((g) => idByName.get(g)).filter(Boolean);
    const groupClaim = p.overage
      ? {
          _claim_names: { groups: "src1" },
          _claim_sources: { src1: { endpoint: "https://graph.microsoft.com/v1.0/users/x/getMemberObjects" } },
        }
      : { groups };
    return sign(
      {
        oid: p.oid,
        sub: createHash("sha256").update(p.oid).digest("hex").slice(0, 43),
        name: p.name,
        roles: p.roles,
        scp: "access_as_user",
        azp: o.clientId,
        idtyp: "user",
        ...groupClaim,
      },
      o.audience,
      extra,
    );
  };

  const app = new Hono();
  const base = `/${t}`;
  app.get(`${base}/v2.0/.well-known/openid-configuration`, (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${o.authority}/${t}/oauth2/v2.0/authorize`,
      token_endpoint: `${o.authority}/${t}/oauth2/v2.0/token`,
      jwks_uri: `${o.authority}/${t}/discovery/v2.0/keys`,
    }),
  );
  app.get(`${base}/discovery/v2.0/keys`, (c) => c.json({ keys: [jwk] }));
  app.get(`${base}/oauth2/v2.0/authorize`, (c) => {
    const q = c.req.query();
    const persona = PERSONAS.find((p) => p.key === q.login_hint);
    if (!persona) return c.text("unknown persona: pass login_hint", 400);
    if (q.client_id !== o.clientId || q.code_challenge_method !== "S256" || !q.code_challenge || !q.redirect_uri)
      return c.text("bad request", 400);
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { persona, nonce: q.nonce ?? "", challenge: q.code_challenge, redirectUri: q.redirect_uri, clientId: q.client_id });
    const to = new URL(q.redirect_uri);
    to.searchParams.set("code", code);
    to.searchParams.set("state", q.state ?? "");
    return c.redirect(to.toString(), 302);
  });
  app.post(`${base}/oauth2/v2.0/token`, async (c) => {
    const f = new URLSearchParams(await c.req.text());
    if (f.get("client_id") !== o.clientId || f.get("client_secret") !== o.clientSecret) return c.json({ error: "invalid_client" }, 401);
    const entry = codes.get(f.get("code") ?? "");
    codes.delete(f.get("code") ?? "");
    if (!entry || entry.redirectUri !== f.get("redirect_uri")) return c.json({ error: "invalid_grant" }, 400);
    const verifier = f.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge)
      return c.json({ error: "invalid_grant", error_description: "PKCE" }, 400);
    const p = entry.persona;
    const id_token = await sign(
      { oid: p.oid, sub: p.oid, name: p.name, nonce: entry.nonce, preferred_username: `${p.key}@edri.example` },
      o.clientId,
    );
    return c.json({ token_type: "Bearer", expires_in: 3600, access_token: await accessToken(p), id_token });
  });
  // Graph's getMemberGroups, for the overage persona
  app.post("/graph/users/:oid/getMemberGroups", (c) => {
    if (state.graphDown) return c.json({ error: "unavailable" }, 503);
    const p = PERSONAS.find((x) => x.oid === c.req.param("oid"));
    return c.json({ value: (p?.groups ?? []).map((g) => idByName.get(g)) });
  });

  return { app, accessToken, state, jwk, issuer };
};
