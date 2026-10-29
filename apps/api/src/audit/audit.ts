/**
 * Append-only audit log, each record chained to the one before by SHA-256. The database refuses
 * UPDATE, DELETE and TRUNCATE on the table; verify() recomputes the chain from the first record.
 */
import { createHash } from "node:crypto";
import { canonical } from "@foundry/contract";
import type { PoolClient } from "pg";
import type { Pool } from "../db/pool.js";

const GENESIS = "0".repeat(64);
const digest = (prev: string, r: { at: string; tid: string | null; actor: string; action: string; target: string; detail: unknown }) =>
  // canonical JSON: jsonb does not keep key order, so the stored detail must hash the same
  createHash("sha256")
    .update(canonical([prev, r.at, r.tid, r.actor, r.action, r.target, r.detail]))
    .digest("hex");

export interface AuditEntry {
  tid: string | null;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export const createAudit = (pool: Pool) => {
  const append = async (c: PoolClient, e: AuditEntry) => {
    // one writer at a time per database keeps the chain linear
    await c.query("select pg_advisory_xact_lock(7213)");
    const prev = (await c.query<{ hash: string }>("select hash from foundry.audit order by seq desc limit 1")).rows[0]?.hash ?? GENESIS;
    const at = new Date().toISOString();
    const detail = e.detail ?? {};
    const hash = digest(prev, { at, tid: e.tid, actor: e.actor, action: e.action, target: e.target, detail });
    await c.query(
      "insert into foundry.audit (at, tid, actor, action, target, detail, prev_hash, hash) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [at, e.tid, e.actor, e.action, e.target, JSON.stringify(detail), prev, hash],
    );
  };
  return {
    /** Inside the caller's transaction, so the record exists exactly when the change does. */
    append,
    async record(e: AuditEntry) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await append(c, e);
        await c.query("commit");
      } catch (err) {
        await c.query("rollback");
        throw err;
      } finally {
        c.release();
      }
    },
    async list(limit = 200, target?: string) {
      const r = await pool.query(
        // order by the table's column: "order by seq" would sort the text output column ("10" < "9")
        `select a.seq::text as seq, a.at, a.actor, a.action, a.target, a.detail, a.hash from foundry.audit a where ($1::text is null or a.target = $1) order by a.seq desc limit $2`,
        [target ?? null, limit],
      );
      return r.rows;
    },
    async verify() {
      const r = await pool.query<{
        seq: string;
        at: Date;
        tid: string | null;
        actor: string;
        action: string;
        target: string;
        detail: unknown;
        prev_hash: string;
        hash: string;
      }>(
        "select a.seq::text as seq, a.at, a.tid, a.actor, a.action, a.target, a.detail, a.prev_hash, a.hash from foundry.audit a order by a.seq",
      );
      let prev = GENESIS;
      for (const row of r.rows) {
        const h = digest(prev, {
          at: row.at.toISOString(),
          tid: row.tid,
          actor: row.actor,
          action: row.action,
          target: row.target,
          detail: row.detail,
        });
        if (row.prev_hash !== prev || row.hash !== h) return { ok: false, records: r.rows.length, brokenAt: row.seq };
        prev = row.hash;
      }
      return { ok: true, records: r.rows.length };
    },
  };
};
export type Audit = ReturnType<typeof createAudit>;
