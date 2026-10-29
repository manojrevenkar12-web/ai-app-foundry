/**
 * Personal access tokens, for AI coding tools and scripts acting as a person (the MCP server uses
 * one). Stored hashed; scoped; at most 30 days; they carry the permissions their owner had when
 * they were made, so they expire rather than outlive a change of role for long.
 */
import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type { Pool } from "../db/pool.js";
import type { Principal } from "./principal.js";

export const SCOPES = ["apps:read", "apps:write", "apps:invoke"] as const;
export type Scope = (typeof SCOPES)[number];
export const MAX_DAYS = 30;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export const createTokens = (pool: Pool) => ({
  async issue(p: Principal, name: string, scopes: Scope[], days: number) {
    const token = `fdy_${randomBytes(32).toString("base64url")}`;
    const id = ulid();
    const snapshot = { name: p.name, roles: p.roles, groups: p.groups, countries: p.countries, groupsKnown: p.groupsKnown };
    await pool.query(
      `insert into foundry.api_tokens (id, tid, oid, name, token_hash, scopes, principal, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8))`,
      [id, p.tid, p.oid, name.slice(0, 80), hash(token), scopes, JSON.stringify(snapshot), Math.min(Math.max(days, 1), MAX_DAYS)],
    );
    return { id, token };
  },
  async resolve(token: string): Promise<Principal | null> {
    const r = await pool.query<{ tid: string; oid: string; principal: Omit<Principal, "tid" | "oid" | "via">; scopes: string[] }>(
      `update foundry.api_tokens set last_used_at = now()
       where token_hash = $1 and revoked_at is null and expires_at > now()
       returning tid, oid, principal, scopes`,
      [hash(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { ...row.principal, tid: row.tid, oid: row.oid, via: "token", scopes: row.scopes };
  },
  async list(p: Principal) {
    const r = await pool.query(
      "select id, name, scopes, created_at, expires_at, revoked_at, last_used_at from foundry.api_tokens where tid = $1 and oid = $2 order by created_at desc",
      [p.tid, p.oid],
    );
    return r.rows;
  },
  async revoke(p: Principal, id: string) {
    const r = await pool.query(
      "update foundry.api_tokens set revoked_at = now() where id = $1 and tid = $2 and oid = $3 and revoked_at is null",
      [id, p.tid, p.oid],
    );
    return (r.rowCount ?? 0) > 0;
  },
});
export type Tokens = ReturnType<typeof createTokens>;
