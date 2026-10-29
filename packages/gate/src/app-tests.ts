/** Runs a bundle's own tests in the sandbox against a simulated platform with the production rules. */
import type { Bundle } from "@foundry/contract";
import { type Host, runHandler } from "@foundry/sandbox";
import type { Catalog } from "./catalog.js";
import { connectorOf } from "./catalog.js";
import { checkCall } from "./enforce.js";

export interface TestResult {
  name: string;
  ok: boolean;
  message: string;
  ms: number;
}

/** The deterministic stand-in model the gate and the offline platform use. */
export const simulatedAnswer = (alias: string, messages: Array<{ content: string }>) => {
  const last = messages[messages.length - 1]?.content ?? "";
  return `[${alias}] ${last.slice(0, 120)}`;
};

export const simulatedHost = (b: Bundle, catalog: Catalog): Host => {
  const store = new Map<string, unknown>();
  return async (op, payload) => {
    const c = checkCall(b.manifest, catalog, op, payload);
    switch (c.op) {
      case "connector":
        return connectorOf(catalog, c.id)?.example ?? {};
      case "llm.chat":
        return { text: simulatedAnswer(c.alias, c.messages), usage: { inputTokens: 10, outputTokens: 10 }, toolCalls: [] };
      case "llm.stream":
        return { id: "simulated-stream" };
      case "store.get":
        return store.get(`${c.collection}/${c.key}`) ?? null;
      case "store.put":
        store.set(`${c.collection}/${c.key}`, c.value);
        return null;
      case "store.delete":
        store.delete(`${c.collection}/${c.key}`);
        return null;
      case "store.list":
        return [...store.entries()]
          .filter(([k]) => k.startsWith(`${c.collection}/${c.prefix}`))
          .slice(0, c.limit)
          .map(([k, v]) => ({ key: k.slice(c.collection.length + 1), value: v }));
    }
  };
};

export const runAppTests = async (b: Bundle, catalog: Catalog): Promise<TestResult[]> => {
  const out: TestResult[] = [];
  for (const t of b.tests) {
    const t0 = performance.now();
    const o = await runHandler({
      code: b.code,
      handler: t.handler,
      input: t.input,
      context: { app: b.manifest.id, user: { name: "Gate", roles: ["Foundry.User"] }, now: "2026-10-29T12:00:00.000Z" },
      host: simulatedHost(b, catalog),
      limits: { wallMs: 5000 },
    });
    const ms = Math.round(performance.now() - t0);
    if (t.expect.errorCode) {
      const ok = o.error?.code === t.expect.errorCode;
      out.push({
        name: t.name,
        ok,
        message: ok ? "failed as expected" : `expected ${t.expect.errorCode}, got ${o.error?.code ?? "success"}`,
        ms,
      });
      continue;
    }
    if (!o.ok) {
      out.push({ name: t.name, ok: false, message: `${o.error?.code}: ${o.error?.message}`, ms });
      continue;
    }
    const text = JSON.stringify(o.directive ?? o.value);
    const missing = t.expect.contains.filter((s) => !text.includes(s));
    out.push({
      name: t.name,
      ok: missing.length === 0,
      message: missing.length ? `result lacks ${missing.map((s) => JSON.stringify(s)).join(", ")}` : "passed",
      ms,
    });
  }
  return out;
};
