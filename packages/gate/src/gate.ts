/**
 * The publish gate. Given a bundle, it reports every problem it can find, runs the bundle's tests
 * in the sandbox and decides the review tier. A bundle with a blocking finding or a failing test
 * cannot be submitted; the runtime enforces the manifest whatever the gate concluded.
 */
import { Bundle, bundleHash, type Manifest } from "@foundry/contract";
import { runAppTests, type TestResult } from "./app-tests.js";
import type { Catalog } from "./catalog.js";
import { connectorOf } from "./catalog.js";
import { analyse } from "./code.js";
import { block, type Finding } from "./findings.js";
import { checkManifest, decideTier, type TierDecision } from "./policy.js";
import { scanSecrets } from "./secrets.js";
import { checkUi } from "./ui-check.js";

export interface CapabilitySummary {
  audience: Manifest["audience"];
  connectors: Array<{ id: string; title: string; access: string; classification: string; external: boolean }>;
  models: Manifest["models"];
  collections: Manifest["collections"];
  budget: Manifest["budget"];
}

export interface GateReport {
  ok: boolean;
  hash: string | null;
  findings: Finding[];
  tests: TestResult[];
  tier: TierDecision | null;
  capabilities: CapabilitySummary | null;
  ms: number;
}

export const runGate = async (input: unknown, catalog: Catalog): Promise<GateReport> => {
  const t0 = performance.now();
  const parsed = Bundle.safeParse(input);
  if (!parsed.success) {
    // secrets are reported even in a bundle that does not parse: it may already be stored somewhere
    const raw = JSON.stringify(input ?? null, null, 1);
    const findings = [
      ...parsed.error.issues.map((i) => block("schema", i.message, { at: i.path.join(".") || "bundle" })),
      ...scanSecrets("the bundle", raw),
    ];
    return { ok: false, hash: null, findings, tests: [], tier: null, capabilities: null, ms: Math.round(performance.now() - t0) };
  }
  const b = parsed.data;
  const facts = analyse(b.code);
  const findings: Finding[] = [
    ...facts.findings,
    ...checkManifest(b.manifest, catalog, facts),
    ...checkUi(b.manifest, b.ui),
    ...scanSecrets("the code", b.code),
    ...scanSecrets("the manifest", JSON.stringify(b.manifest, null, 1)),
    ...scanSecrets("the UI", JSON.stringify(b.ui, null, 1)),
    ...scanSecrets("the tests", JSON.stringify(b.tests, null, 1)),
  ];
  const parses = !findings.some((f) => f.rule === "code.syntax");
  const tests = parses ? await runAppTests(b, catalog) : [];
  if (b.tests.length === 0) findings.push(block("tests.none", "add at least one test: an example input and what the result must contain"));
  const tier = decideTier(b.manifest, catalog, findings);
  const ok = !findings.some((f) => f.severity === "block") && tests.every((t) => t.ok);
  return {
    ok,
    hash: bundleHash(b),
    findings,
    tests,
    tier,
    capabilities: {
      audience: b.manifest.audience,
      connectors: b.manifest.connectors.map((c) => {
        const d = connectorOf(catalog, c.id);
        return {
          id: c.id,
          title: d?.title ?? c.id,
          access: d?.access ?? "?",
          classification: d?.classification ?? "?",
          external: d?.external ?? false,
        };
      }),
      models: b.manifest.models,
      collections: b.manifest.collections,
      budget: b.manifest.budget,
    },
    ms: Math.round(performance.now() - t0),
  };
};
