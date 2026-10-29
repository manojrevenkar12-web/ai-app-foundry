/**
 * Manifest rules and the review tier. The tier decides who must approve before an app goes live:
 * tier 0 publishes after the checks, tier 1 needs a second builder, tier 2 needs a platform
 * reviewer. It rises with what the app can reach and how many people can open it.
 */
import { classificationRank, type Manifest } from "@foundry/contract";
import type { Catalog } from "./catalog.js";
import { connectorOf } from "./catalog.js";
import type { CodeFacts } from "./code.js";
import { block, type Finding, info, warn } from "./findings.js";

export type Tier = 0 | 1 | 2;
export interface TierDecision {
  tier: Tier;
  reasons: string[];
  approvals: { count: number; role: "Foundry.Builder" | "Foundry.Reviewer" | null };
}

const EUR_REVIEW_THRESHOLD = 50;

export const checkManifest = (m: Manifest, catalog: Catalog, facts: CodeFacts): Finding[] => {
  const out: Finding[] = [];
  m.connectors.forEach((c, i) => {
    if (!connectorOf(catalog, c.id))
      out.push(block("manifest.connector", `connector ${c.id} does not exist on this platform`, { at: `manifest.connectors[${i}]` }));
  });
  m.models.forEach((u, i) => {
    if (!catalog.models.some((x) => x.alias === u.alias))
      out.push(block("manifest.model", `model alias ${u.alias} is not offered`, { at: `manifest.models[${i}]` }));
  });

  // the code may use only what the manifest declares (the runtime enforces the same)
  const declared = {
    connector: new Set(m.connectors.map((c) => c.id)),
    model: new Set(m.models.map((x) => x.alias as string)),
    collection: new Set(m.collections.map((c) => c.name)),
  };
  for (const u of facts.uses) {
    if (u.id === null) continue;
    const at = { line: u.line, column: u.column };
    if ((u.kind === "connector" || u.kind === "tool" || u.kind === "confirm") && !declared.connector.has(u.id))
      out.push(block("code.undeclared", `the code uses connector ${u.id}, which the manifest does not declare`, at));
    if (u.kind === "model" && !declared.model.has(u.id))
      out.push(block("code.undeclared", `the code uses model ${u.id}, which the manifest does not declare`, at));
    if (u.kind === "collection" && !declared.collection.has(u.id))
      out.push(block("code.undeclared", `the code uses collection ${u.id}, which the manifest does not declare`, at));
    const def = u.id ? connectorOf(catalog, u.id) : undefined;
    if (u.kind === "connector" && def?.access === "write")
      out.push(
        block(
          "code.write-without-confirm",
          `${u.id} changes data; return ctx.confirm({ connector: "${u.id}", ... }) so the viewer confirms it`,
          at,
        ),
      );
    if (u.kind === "tool" && def?.access === "write")
      out.push(
        block("code.write-tool", `a model cannot be given ${u.id}: it changes data, and model output is not a person's decision`, at),
      );
    if (u.kind === "confirm" && def && def.access !== "write")
      out.push(warn("code.confirm-read", `${u.id} only reads; it needs no confirmation`, at));
  }

  // handlers: every declared handler must be exported
  for (const h of m.handlers)
    if (!facts.exports.includes(h.name))
      out.push(block("code.missing-handler", `handler ${h.name} is declared but not exported by the code`));
  for (const e of facts.exports)
    if (!m.handlers.some((h) => h.name === e))
      out.push(info("code.unlisted-export", `${e} is exported but not declared as a handler, so nobody can call it`));

  // data flow: a handler that reads a connector and writes a collection holding less-protected data
  const byFn = new Map<string, typeof facts.uses>();
  for (const u of facts.uses) byFn.set(u.fn ?? "", [...(byFn.get(u.fn ?? "") ?? []), u]);
  for (const [fn, list] of byFn) {
    const reads = list
      .filter((u) => (u.kind === "connector" || u.kind === "tool") && u.id)
      .map((u) => connectorOf(catalog, u.id as string))
      .filter(Boolean);
    const writes = list
      .filter((u) => u.kind === "collection" && u.op === "put" && u.id)
      .map((u) => m.collections.find((c) => c.name === u.id))
      .filter(Boolean);
    for (const r of reads)
      for (const w of writes) {
        if (!r || !w) continue;
        if (classificationRank(w.classification) < classificationRank(r.classification))
          out.push(
            block(
              "flow.downgrade",
              `${fn || "a handler"} reads ${r.id} (${r.classification}) and writes collection ${w.name} (${w.classification})`,
            ),
          );
        if (w.scope === "shared" && !r.allowedGroups.includes("EDRI-All") && m.audience.kind !== "owner")
          out.push(
            warn(
              "flow.shared-copy",
              `${fn || "a handler"} copies ${r.id} into the shared collection ${w.name}; viewers who may not read ${r.id} could see it there`,
            ),
          );
      }
  }

  // audience: viewers outside a connector's groups will be refused at run time
  if (m.audience.kind === "company")
    for (const c of m.connectors) {
      const def = connectorOf(catalog, c.id);
      if (def && !def.allowedGroups.includes("EDRI-All"))
        out.push(info("audience.partial", `${c.id} is limited to ${def.allowedGroups.join(", ")}; other viewers get FORBIDDEN_FOR_VIEWER`));
    }

  // budget: worst case per call, shown to the reviewer
  for (const u of m.models) {
    const def = catalog.models.find((x) => x.alias === u.alias);
    if (!def) continue;
    const perCall = (u.maxTokensPerCall * def.eurPerMillionOut + 8000 * def.eurPerMillionIn) / 1e6;
    if (perCall > 0 && m.budget.eurPerDay / perCall < 10)
      out.push(warn("budget.small", `the daily budget covers fewer than 10 worst-case ${u.alias} calls`));
  }
  return out;
};

export const decideTier = (m: Manifest, catalog: Catalog, findings: Finding[]): TierDecision => {
  const reasons2: string[] = [];
  const reasons1: string[] = [];
  for (const c of m.connectors) {
    const def = connectorOf(catalog, c.id);
    if (!def) continue;
    if (def.classification === "confidential") reasons2.push(`reads confidential data (${c.id})`);
    if (def.access === "write") reasons2.push(`changes data in another system (${c.id})`);
    if (def.external) reasons2.push(`sends data outside the platform (${c.id})`);
  }
  for (const col of m.collections) if (col.classification === "confidential") reasons2.push(`stores confidential data (${col.name})`);
  if (m.budget.eurPerDay > EUR_REVIEW_THRESHOLD) reasons2.push(`budget above €${EUR_REVIEW_THRESHOLD} a day`);
  if (m.audience.kind === "company") reasons1.push("open to the whole company");
  if (m.collections.some((c) => c.scope === "shared") && m.audience.kind !== "owner") reasons1.push("keeps data shared between viewers");
  for (const f of findings)
    if (f.severity === "warn" && f.rule.startsWith("code."))
      reasons1.push(`code the reviewer should read (${f.rule}${f.line ? ` at line ${f.line}` : ""})`);
  if (reasons2.length) return { tier: 2, reasons: [...new Set(reasons2)], approvals: { count: 1, role: "Foundry.Reviewer" } };
  if (reasons1.length) return { tier: 1, reasons: [...new Set(reasons1)], approvals: { count: 1, role: "Foundry.Builder" } };
  return { tier: 0, reasons: ["only internal data, no writes, no shared storage, limited audience"], approvals: { count: 0, role: null } };
};
