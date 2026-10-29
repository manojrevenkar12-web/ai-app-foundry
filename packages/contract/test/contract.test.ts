import { describe, expect, it } from "vitest";
import { Bundle, bundleHash, canonical, Manifest, UiSpec } from "../src/index.js";

const manifest = {
  id: "site-snapshot",
  name: "Site snapshot",
  description: "Charge points in a city, right now.",
  audience: { kind: "company" },
  handlers: [{ name: "snapshot", input: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
  budget: { eurPerDay: 5, tokensPerUserPerDay: 1000 },
};

describe("manifest", () => {
  it("accepts a minimal manifest and fills defaults", () => {
    const m = Manifest.parse(manifest);
    expect(m.models).toEqual([]);
    expect(m.handlers[0]?.streams).toBe(false);
  });
  it("refuses unknown keys, so a typo cannot silently grant nothing or everything", () => {
    expect(Manifest.safeParse({ ...manifest, conectors: [] }).success).toBe(false);
  });
  it("refuses duplicate handlers and connectors", () => {
    const dup = { ...manifest, handlers: [...manifest.handlers, ...manifest.handlers] };
    expect(Manifest.safeParse(dup).error?.issues[0]?.message).toMatch(/declared twice/);
    expect(Manifest.safeParse({ ...manifest, connectors: [{ id: "docs.search" }, { id: "docs.search" }] }).success).toBe(false);
  });
  it("caps budgets", () => {
    expect(Manifest.safeParse({ ...manifest, budget: { eurPerDay: 10_000, tokensPerUserPerDay: 1 } }).success).toBe(false);
  });
});

describe("UI spec", () => {
  it("has no way to carry script: only known block types and fields", () => {
    expect(UiSpec.safeParse({ pages: [{ id: "main", title: "Main", blocks: [{ type: "html", html: "<script>" }] }] }).success).toBe(false);
    expect(
      UiSpec.safeParse({ pages: [{ id: "main", title: "Main", blocks: [{ type: "markdown", text: "hi", onClick: "x" }] }] }).success,
    ).toBe(false);
  });
});

describe("bundle hash", () => {
  const bundle = Bundle.parse({
    manifest,
    code: "export function snapshot() {}",
    ui: { pages: [{ id: "main", title: "Main", blocks: [{ type: "markdown", text: "hi" }] }] },
  });
  it("does not depend on key order", () => {
    const reordered = { ui: bundle.ui, tests: bundle.tests, code: bundle.code, manifest: bundle.manifest };
    expect(canonical(reordered)).toBe(canonical(bundle));
    expect(bundleHash(Bundle.parse(reordered))).toBe(bundleHash(bundle));
  });
  it("changes when one character of the code changes", () => {
    expect(bundleHash({ ...bundle, code: `${bundle.code} ` })).not.toBe(bundleHash(bundle));
  });
});

import { toZod } from "../src/index.js";

describe("handler input validation", () => {
  const v = toZod({
    type: "object",
    properties: {
      country: { type: "string", enum: ["DE", "NL"] },
      months: { type: "number", minimum: 1, maximum: 12 },
      note: { type: "string", maxLength: 5 },
    },
    required: ["country"],
  });
  it("accepts what the handler declares", () => {
    expect(v.safeParse({ country: "DE", months: 3 }).success).toBe(true);
  });
  it("refuses everything else, including extra fields", () => {
    for (const bad of [
      {},
      { country: "FR" },
      { country: "DE", months: 13 },
      { country: "DE", note: "too long" },
      { country: "DE", admin: true },
    ])
      expect(v.safeParse(bad).success).toBe(false);
  });
});
