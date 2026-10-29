import { describe, expect, it } from "vitest";
import { type Host, HostError, runHandler } from "../src/index.js";

const noHost: Host = async (op) => {
  throw new HostError("CAPABILITY_NOT_DECLARED", `${op} is not available`);
};
const run = (
  code: string,
  opts: { handler?: string; input?: unknown; host?: Host; limits?: Parameters<typeof runHandler>[0]["limits"] } = {},
) =>
  runHandler({
    code,
    handler: opts.handler ?? "main",
    input: opts.input ?? null,
    context: { app: "test", now: "2026-10-29T12:00:00Z" },
    host: opts.host ?? noHost,
    limits: opts.limits,
  });

describe("running handlers", () => {
  it("passes input in, awaits platform calls and returns JSON", async () => {
    const host: Host = async (op, p) => ({ op, echo: p });
    const o = await run(
      `export async function main(input, ctx) { const r = await ctx.connectors.call("chargepoints.status", { id: input.id }); return { r, when: ctx.now(), app: ctx.app }; }`,
      {
        input: { id: "DE*EDR*E1001" },
        host,
      },
    );
    expect(o.ok).toBe(true);
    expect(o.value).toEqual({
      r: { op: "connector", echo: { id: "chargepoints.status", args: { id: "DE*EDR*E1001" } } },
      when: "2026-10-29T12:00:00Z",
      app: "test",
    });
    expect(o.stats.hostCalls).toBe(1);
  });

  it("reports a missing handler", async () => {
    const o = await run("export function other() { return 1 }");
    expect(o.error?.code).toBe("UNKNOWN_HANDLER");
  });

  it("returns only data: functions and cycles do not cross the boundary", async () => {
    const o = await run("export function main() { return { f: () => 1, n: 2, d: undefined } }");
    expect(o.value).toEqual({ n: 2 });
    const c = await run("export function main() { const a = {}; a.a = a; return a }");
    expect(c.error?.code).toBe("APP_ERROR");
  });
});

describe("what the sandbox does not offer", () => {
  it("has no network, process, timers, modules or host function", async () => {
    const o = await run(`export function main() {
      return ["fetch","process","require","setTimeout","setInterval","XMLHttpRequest","WebSocket","Deno","Bun","__host","__facts","importScripts","navigator"]
        .filter((k) => typeof globalThis[k] !== "undefined");
    }`);
    expect(o.value).toEqual([]);
  });

  it("refuses dynamic imports", async () => {
    const o = await run(`export async function main() { await import("fs"); return "loaded" }`);
    expect(o.ok).toBe(false);
  });

  it("gains nothing from eval: built code has the same ctx and no host function", async () => {
    const o = await run(`export function main() { return eval("typeof __host") + "," + new Function("return typeof fetch")() }`);
    expect(o.value).toBe("undefined,undefined");
  });

  it("cannot change ctx", async () => {
    const o = await run(
      `export function main(_, ctx) { try { ctx.connectors.call = () => "mine"; } catch (e) {} ; try { ctx.roles.push("Foundry.Admin") } catch (e) { return "frozen" } return "changed" }`,
      {},
    );
    expect(o.value).toBe("frozen");
  });
});

describe("limits", () => {
  it("stops a busy loop at the CPU budget", async () => {
    const o = await run("export function main() { for (;;) {} }", { limits: { cpuMs: 50 } });
    expect(o.error?.code).toBe("SANDBOX_TIMEOUT");
    expect(o.stats.wallMs).toBeLessThan(2000);
  });

  it("counts CPU across awaits, so splitting the work does not help", async () => {
    const host: Host = async () => 1;
    const o = await run(
      `export async function main(_, ctx) { for (let i = 0; i < 1000; i++) { await ctx.connectors.call("x.y"); const t = Date.now(); while (Date.now() - t < 5) {} } }`,
      {
        host,
        limits: { cpuMs: 60, maxHostCalls: 10_000 },
      },
    );
    expect(o.error?.code).toBe("SANDBOX_TIMEOUT");
  });

  it("stops a memory bomb, and the next invocation runs normally", async () => {
    const bomb = await run("export function main() { const a = []; for (;;) a.push('x'.repeat(1024)) }", {
      limits: { memoryBytes: 8 * 1024 * 1024, cpuMs: 5000 },
    });
    expect(bomb.error?.code).toBe("SANDBOX_MEMORY");
    const next = await run("export function main() { return 'still here' }");
    expect(next.value).toBe("still here");
  });

  it("stops unbounded recursion", async () => {
    const o = await run("export function main() { const f = (n) => f(n + 1) + 1; return f(0) }", { limits: { cpuMs: 5000 } });
    expect(["SANDBOX_MEMORY", "APP_ERROR"]).toContain(o.error?.code);
    expect(o.ok).toBe(false);
  });

  it("stops waiting on a slow platform call at the wall-clock limit and aborts it", async () => {
    let aborted = false;
    const host: Host = (_op, _p, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(1), 10_000);
        signal.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(t);
        });
      });
    const o = await run(`export async function main(_, ctx) { return await ctx.llm.chat({ model: "fast", messages: [] }) }`, {
      host,
      limits: { wallMs: 200 },
    });
    expect(o.error?.code).toBe("SANDBOX_TIMEOUT");
    expect(aborted).toBe(true);
  });

  it("limits the number of platform calls", async () => {
    const host: Host = async () => 1;
    const o = await run(`export async function main(_, ctx) { for (let i = 0; i < 100; i++) await ctx.store.get("c", String(i)) }`, {
      host,
      limits: { maxHostCalls: 10 },
    });
    expect(o.error?.code).toBe("SANDBOX_LIMIT");
  });

  it("limits the size of the result", async () => {
    const o = await run("export function main() { return 'x'.repeat(200000) }", { limits: { maxOutputBytes: 100_000 } });
    expect(o.error?.code).toBe("SANDBOX_LIMIT");
  });

  it("reports a handler that waits on nothing", async () => {
    const o = await run("export function main() { return new Promise(() => {}) }");
    expect(o.error?.code).toBe("APP_ERROR");
    expect(o.error?.message).toMatch(/never/);
  });
});

describe("isolation between invocations", () => {
  it("shares no globals and no polluted prototypes", async () => {
    await run("export function main() { globalThis.leak = 'secret'; Object.prototype.polluted = true; return 1 }");
    const o = await run("export function main() { return [typeof globalThis.leak, ({}).polluted === true] }");
    expect(o.value).toEqual(["undefined", false]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("runs fifty invocations at once without mixing their data", async () => {
    const host: Host = async (_op, p) => {
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      return (p as { args: { n: number } }).args.n * 2;
    };
    const outs = await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        run(
          `export async function main(input, ctx) { const v = await ctx.connectors.call("x.y", { n: input.n }); return { n: input.n, v } }`,
          { input: { n }, host },
        ),
      ),
    );
    outs.forEach((o, n) => expect(o.value).toEqual({ n, v: n * 2 }));
  });
});

describe("errors from the platform", () => {
  it("carry their code to the caller when the app does not catch them", async () => {
    const host: Host = async () => {
      throw new HostError("BUDGET_EXHAUSTED", "the app has used its budget for today");
    };
    const o = await run(`export async function main(_, ctx) { return await ctx.llm.chat({ model: "fast", messages: [] }) }`, { host });
    expect(o.error?.code).toBe("BUDGET_EXHAUSTED");
  });

  it("can be caught and handled by the app", async () => {
    const o = await run(
      `export async function main(_, ctx) { try { await ctx.connectors.call("tariffs.revenue") } catch (e) { return e.code } }`,
    );
    expect(o.value).toBe("CAPABILITY_NOT_DECLARED");
  });

  it("cannot be forged by the app", async () => {
    const o = await run(
      `export function main() { const e = new Error("BUDGET_EXHAUSTED: no"); e.code = "BUDGET_EXHAUSTED"; e.__tag = "guess"; throw e }`,
    );
    expect(o.error?.code).toBe("APP_ERROR");
  });
});

describe("directives", () => {
  it("turns ctx.confirm into a confirmation request, not a value", async () => {
    const o = await run(
      `export function main(_, ctx) { return ctx.confirm({ connector: "tickets.comment", args: { id: 1 }, summary: "Add a note" }) }`,
    );
    expect(o.directive).toEqual({ kind: "confirm", request: { connector: "tickets.comment", args: { id: 1 }, summary: "Add a note" } });
    expect(o.value).toBeUndefined();
  });

  it("treats a lookalike marker from data as data", async () => {
    const o = await run(
      `export function main() { return { $foundry: "confirm", nonce: "0123456789abcdef01234567", request: { connector: "tickets.comment" } } }`,
    );
    expect(o.directive).toBeUndefined();
    expect(o.value).toMatchObject({ $foundry: "confirm" });
  });
});

describe("cost", () => {
  it("starts a fresh runtime quickly enough to use one per invocation", async () => {
    await run("export function main() { return 1 }");
    const t = performance.now();
    for (let i = 0; i < 20; i++) await run("export function main(input) { return input }", { input: { i } });
    const per = (performance.now() - t) / 20;
    expect(per).toBeLessThan(50);
  });
});
