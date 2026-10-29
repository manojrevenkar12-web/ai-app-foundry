/**
 * Apps and their versions. A version is immutable: its bundle, hash and gate report never change.
 * Approvals name the hash they approve. Publishing points the app at an approved version;
 * rolling back points it at an earlier one, whose approvals still hold because it never changed.
 */
import { type Audience, Bundle, type Manifest } from "@foundry/contract";
import { type Catalog, type GateReport, runGate } from "@foundry/gate";
import type { PoolClient } from "pg";
import type { Audit } from "../audit/audit.js";
import type { Pool } from "../db/pool.js";
import { tx } from "../db/scope.js";
import { conflict, forbidden, invalid, notFound } from "../http/problem.js";
import { has, type Principal } from "../identity/principal.js";

export type VersionStatus = "blocked" | "in_review" | "approved" | "live" | "superseded" | "rejected" | "withdrawn";

export interface AppRow {
  id: string;
  tid: string;
  owner_oid: string;
  owner_name: string;
  name: string;
  description: string;
  status: "draft" | "live" | "disabled";
  live_version: number | null;
  created_at: Date;
  updated_at: Date;
}
export interface VersionRow {
  app_id: string;
  number: number;
  bundle: Bundle;
  bundle_hash: string;
  gate: GateReport;
  tier: 0 | 1 | 2;
  status: VersionStatus;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  decided_at: Date | null;
}

/** Whether a person can open an app with this audience. */
export const inAudience = (a: Audience, ownerOid: string, p: Principal) => {
  if (!has(p, "Foundry.User", "Foundry.Builder", "Foundry.Reviewer", "Foundry.Admin")) return false;
  if (a.kind === "owner") return p.oid === ownerOid;
  if (a.kind === "groups") return p.oid === ownerOid || a.groups.some((g) => p.groups.includes(g));
  return true;
};

export const createRegistry = (d: { pool: Pool; catalog: Catalog; audit: Audit }) => {
  const app = async (c: PoolClient | Pool, id: string, lock = false) => {
    const r = await c.query<AppRow>(`select * from foundry.apps where id = $1 ${lock ? "for update" : ""}`, [id]);
    return r.rows[0];
  };
  const version = async (c: PoolClient | Pool, id: string, n: number) =>
    (await c.query<VersionRow>("select * from foundry.app_versions where app_id = $1 and number = $2", [id, n])).rows[0];
  const canEdit = (a: AppRow, p: Principal) => a.owner_oid === p.oid || has(p, "Foundry.Admin");

  return {
    app: (id: string) => app(d.pool, id),
    version: (id: string, n: number) => version(d.pool, id, n),

    async versions(id: string) {
      return (
        await d.pool.query(
          `select app_id, number, bundle_hash, tier, status, created_by_name, created_at, decided_at, gate->'ok' as gate_ok,
             (select coalesce(json_agg(json_build_object('reviewer', reviewer_name, 'decision', decision, 'hash', bundle_hash, 'comment', comment, 'at', at) order by at), '[]') from foundry.approvals a where a.app_id = v.app_id and a.number = v.number) as decisions
           from foundry.app_versions v where app_id = $1 order by number desc`,
          [id],
        )
      ).rows;
    },

    /** Runs the gate without storing anything: what an AI coding tool calls while it iterates. */
    check: (bundle: unknown) => runGate(bundle, d.catalog),

    /**
     * Stores a new version after the gate. Tier 0 versions are approved at once; others wait for
     * review. A version the gate blocks is kept, so the author and reviewers can see why.
     */
    async submit(p: Principal, bundle: unknown) {
      if (!has(p, "Foundry.Builder")) throw forbidden("NOT_A_BUILDER", "submitting apps needs the Foundry.Builder role");
      const report = await runGate(bundle, d.catalog);
      const { hash, tier } = report;
      if (!hash || !tier) throw invalid("the bundle is not valid", { findings: report.findings });
      const b = Bundle.parse(bundle);
      const m: Manifest = b.manifest;
      const status: VersionStatus = !report.ok ? "blocked" : tier.tier === 0 ? "approved" : "in_review";
      return tx(d.pool, async (c) => {
        let a = await app(c, m.id, true);
        if (!a) {
          await c.query("insert into foundry.apps (id, tid, owner_oid, owner_name, name, description) values ($1, $2, $3, $4, $5, $6)", [
            m.id,
            p.tid,
            p.oid,
            p.name,
            m.name,
            m.description,
          ]);
          a = await app(c, m.id, true);
        } else if (!canEdit(a, p)) throw forbidden("NOT_OWNER", `${m.id} belongs to ${a.owner_name}`);
        if (!a) throw notFound(m.id);
        const n = ((
          await c.query<{ n: number }>("select coalesce(max(number), 0) + 1 as n from foundry.app_versions where app_id = $1", [m.id])
        ).rows[0]?.n ?? 1) as number;
        await c.query(
          `insert into foundry.app_versions (app_id, number, bundle, bundle_hash, gate, tier, status, created_by, created_by_name, decided_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            m.id,
            n,
            JSON.stringify(b),
            hash,
            JSON.stringify(report),
            tier.tier,
            status,
            p.oid,
            p.name,
            status === "approved" ? new Date() : null,
          ],
        );
        await c.query("update foundry.apps set name = $2, description = $3, updated_at = now() where id = $1", [
          m.id,
          m.name,
          m.description,
        ]);
        await d.audit.append(c, {
          tid: p.tid,
          actor: p.oid,
          action: "version.submitted",
          target: `${m.id}@${n}`,
          detail: { hash, tier: tier.tier, status, blocking: report.findings.filter((f) => f.severity === "block").length },
        });
        return { app: m.id, number: n, status, report };
      });
    },

    /** A reviewer decides on exactly the bundle they read: the hash they send must be the version's. */
    async decide(p: Principal, id: string, n: number, decision: "approve" | "reject", hash: string, comment: string) {
      return tx(d.pool, async (c) => {
        const a = await app(c, id, true);
        if (!a) throw notFound(id);
        const v = await version(c, id, n);
        if (!v) throw notFound(`${id}@${n}`);
        if (v.status !== "in_review") throw conflict("NOT_IN_REVIEW", `version ${n} is ${v.status}`);
        if (v.created_by === p.oid || a.owner_oid === p.oid) throw forbidden("FOUR_EYES", "the author or owner of an app cannot review it");
        const needed = v.gate.tier?.approvals.role;
        if (needed === "Foundry.Reviewer" && !has(p, "Foundry.Reviewer"))
          throw forbidden("REVIEWER_REQUIRED", `tier ${v.tier} apps need a Foundry.Reviewer`);
        if (needed === "Foundry.Builder" && !has(p, "Foundry.Builder", "Foundry.Reviewer"))
          throw forbidden("BUILDER_REQUIRED", "tier 1 apps need another builder or a reviewer");
        if (hash !== v.bundle_hash)
          throw conflict("HASH_MISMATCH", "the bundle you reviewed is not this version's bundle", { expected: v.bundle_hash });
        await c.query(
          "insert into foundry.approvals (app_id, number, reviewer_oid, reviewer_name, bundle_hash, decision, comment) values ($1, $2, $3, $4, $5, $6, $7)",
          [id, n, p.oid, p.name, hash, decision, comment.slice(0, 2000)],
        );
        const approvals = Number(
          (
            await c.query<{ n: string }>(
              "select count(*) as n from foundry.approvals where app_id = $1 and number = $2 and decision = 'approve' and bundle_hash = $3",
              [id, n, v.bundle_hash],
            )
          ).rows[0]?.n,
        );
        const required = v.gate.tier?.approvals.count ?? 1;
        const status: VersionStatus = decision === "reject" ? "rejected" : approvals >= required ? "approved" : "in_review";
        if (status !== "in_review")
          await c.query("update foundry.app_versions set status = $3, decided_at = now() where app_id = $1 and number = $2", [
            id,
            n,
            status,
          ]);
        await d.audit.append(c, {
          tid: p.tid,
          actor: p.oid,
          action: `version.${decision}d`,
          target: `${id}@${n}`,
          detail: { hash, comment: comment.slice(0, 200) },
        });
        return { status };
      });
    },

    /** Make an approved version live (also how a rollback is done: publish an earlier version). */
    async publish(p: Principal, id: string, n: number) {
      return tx(d.pool, async (c) => {
        const a = await app(c, id, true);
        if (!a) throw notFound(id);
        if (!canEdit(a, p)) throw forbidden("NOT_OWNER", `${id} belongs to ${a.owner_name}`);
        const v = await version(c, id, n);
        if (!v) throw notFound(`${id}@${n}`);
        if (!["approved", "superseded", "live"].includes(v.status)) throw conflict("NOT_APPROVED", `version ${n} is ${v.status}`);
        if (a.live_version && a.live_version !== n)
          await c.query("update foundry.app_versions set status = 'superseded' where app_id = $1 and number = $2", [id, a.live_version]);
        await c.query("update foundry.app_versions set status = 'live' where app_id = $1 and number = $2", [id, n]);
        await c.query("update foundry.apps set status = 'live', live_version = $2, updated_at = now() where id = $1", [id, n]);
        await d.audit.append(c, {
          tid: p.tid,
          actor: p.oid,
          action: a.live_version && a.live_version > n ? "app.rolled-back" : "app.published",
          target: `${id}@${n}`,
          detail: { from: a.live_version },
        });
        return { live: n };
      });
    },

    async disable(p: Principal, id: string, reason: string) {
      return tx(d.pool, async (c) => {
        const a = await app(c, id, true);
        if (!a) throw notFound(id);
        if (!canEdit(a, p)) throw forbidden("NOT_OWNER", "only the owner or an admin can disable an app");
        await c.query("update foundry.apps set status = 'disabled', updated_at = now() where id = $1", [id]);
        await d.audit.append(c, { tid: p.tid, actor: p.oid, action: "app.disabled", target: id, detail: { reason: reason.slice(0, 300) } });
        return { status: "disabled" };
      });
    },

    /** Apps this person can open, plus apps they own. */
    async catalogFor(p: Principal) {
      const r = await d.pool.query<AppRow & { bundle: Bundle; tier: number }>(
        `select a.*, v.bundle, v.tier from foundry.apps a left join foundry.app_versions v on v.app_id = a.id and v.number = a.live_version
         where a.tid = $1 order by a.updated_at desc`,
        [p.tid],
      );
      return r.rows
        .filter((a) => a.owner_oid === p.oid || (a.status === "live" && a.bundle && inAudience(a.bundle.manifest.audience, a.owner_oid, p)))
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          owner: a.owner_name,
          mine: a.owner_oid === p.oid,
          status: a.status,
          liveVersion: a.live_version,
          tier: a.tier ?? null,
          audience: a.bundle?.manifest.audience ?? null,
          updatedAt: a.updated_at,
        }));
    },

    /** Versions waiting for this reviewer. */
    async reviewQueue(p: Principal) {
      if (!has(p, "Foundry.Builder", "Foundry.Reviewer")) return [];
      const r = await d.pool.query(
        `select v.app_id, v.number, v.tier, v.created_by_name, v.created_at, v.bundle_hash, a.name, a.owner_oid, v.created_by
         from foundry.app_versions v join foundry.apps a on a.id = v.app_id where v.status = 'in_review' and a.tid = $1 order by v.created_at`,
        [p.tid],
      );
      return r.rows
        .filter((v) => v.created_by !== p.oid && v.owner_oid !== p.oid && (v.tier < 2 || has(p, "Foundry.Reviewer")))
        .map(({ owner_oid: _o, created_by: _c, ...rest }) => rest);
    },
  };
};
export type Registry = ReturnType<typeof createRegistry>;
