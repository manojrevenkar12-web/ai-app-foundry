/**
 * Validates Entra ID access tokens issued for this API and turns them into a Principal.
 * Follows Microsoft's claims-validation guidance: issuer, audience, tenant, algorithm, user (not
 * app-only) tokens, identity by oid + tid, permissions from app roles and group object ids.
 */
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { type Directory, resolveGroups } from "./directory.js";
import type { Principal, Role } from "./principal.js";

const ROLES: Role[] = ["Foundry.User", "Foundry.Builder", "Foundry.Reviewer", "Foundry.Admin"];

export interface Graph {
  /** transitive group object ids of a user, for when the token's groups claim overflowed */
  memberGroups(tid: string, oid: string, signal: AbortSignal): Promise<string[]>;
}

export class TokenError extends Error {}

export interface EntraOptions {
  authority: string;
  tenantId: string;
  audience: string;
  directory: Directory;
  graph: Graph;
  keys?: JWTVerifyGetKey;
  graphTimeoutMs?: number;
}

export const issuerOf = (authority: string, tid: string) => `${authority.replace(/\/$/, "")}/${tid}/v2.0`;
export const jwksUrlOf = (authority: string, tid: string) => `${authority.replace(/\/$/, "")}/${tid}/discovery/v2.0/keys`;

export const createEntraValidator = (o: EntraOptions) => {
  const keys =
    o.keys ?? createRemoteJWKSet(new URL(jwksUrlOf(o.authority, o.tenantId)), { cooldownDuration: 30_000, cacheMaxAge: 3_600_000 });
  const issuer = issuerOf(o.authority, o.tenantId);

  return async (token: string): Promise<Principal> => {
    let payload: JWTPayload & Record<string, unknown>;
    try {
      ({ payload } = (await jwtVerify(token, keys, { issuer, audience: o.audience, algorithms: ["RS256"], clockTolerance: 60 })) as {
        payload: JWTPayload & Record<string, unknown>;
      });
    } catch (e) {
      throw new TokenError(`token rejected: ${(e as Error).message}`);
    }
    if (payload.tid !== o.tenantId) throw new TokenError("token is from another tenant");
    if (payload.idtyp === "app") throw new TokenError("app-only tokens cannot call user routes");
    const oid = typeof payload.oid === "string" ? payload.oid : "";
    if (!oid) throw new TokenError("token has no oid");

    const roles = (Array.isArray(payload.roles) ? payload.roles : []).filter((r): r is Role => ROLES.includes(r as Role));
    let groupIds: string[] = [];
    let groupsKnown = true;
    const claimNames = payload._claim_names as Record<string, string> | undefined;
    if (Array.isArray(payload.groups)) groupIds = payload.groups.map(String);
    else if (claimNames?.groups || payload.hasgroups === true) {
      // overage: more groups than fit in a token. Ask Graph, never a URL from the token.
      try {
        groupIds = await o.graph.memberGroups(o.tenantId, oid, AbortSignal.timeout(o.graphTimeoutMs ?? 3000));
      } catch {
        groupsKnown = false;
      }
    }
    // The app registration emits only groups assigned to the application, so no claim means none.
    const { names, countries } = groupsKnown ? resolveGroups(o.directory, groupIds) : { names: [], countries: [] };
    return {
      tid: o.tenantId,
      oid,
      name: typeof payload.name === "string" ? payload.name : oid,
      roles,
      groups: names,
      countries,
      groupsKnown,
      via: "token",
    };
  };
};

/** Microsoft Graph with an app token from client credentials. */
export const createGraph = (o: {
  authority: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  graphUrl?: string;
}): Graph => {
  let cached: { token: string; until: number } | undefined;
  const appToken = async (signal: AbortSignal) => {
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await fetch(`${o.authority}/${o.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      signal,
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: o.clientId,
        client_secret: o.clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    return cached.token;
  };
  return {
    async memberGroups(_tid, oid, signal) {
      const res = await fetch(`${o.graphUrl ?? "https://graph.microsoft.com/v1.0"}/users/${encodeURIComponent(oid)}/getMemberGroups`, {
        method: "POST",
        signal,
        headers: { authorization: `Bearer ${await appToken(signal)}`, "content-type": "application/json" },
        body: JSON.stringify({ securityEnabledOnly: true }),
      });
      if (!res.ok) throw new Error(`graph ${res.status}`);
      return ((await res.json()) as { value: string[] }).value;
    },
  };
};
