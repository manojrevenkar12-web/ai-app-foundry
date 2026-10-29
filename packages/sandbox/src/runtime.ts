/**
 * Runs one handler invocation of an app in a fresh QuickJS runtime compiled to WebAssembly.
 *
 * The app's code sees no network, no file system, no clock beyond ctx.now(), no process and no
 * other invocation's state. Its only way out is a single host function, captured in a closure by
 * the prelude and deleted from the global object before app code runs. Every host operation is
 * checked by the caller against the app's manifest; this module enforces time, memory, stack,
 * host-call count and output size.
 */

import { randomBytes } from "node:crypto";
import type { ErrorCode } from "@foundry/contract";
import variantModule from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSSyncVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

export interface Limits {
  memoryBytes: number;
  stackBytes: number;
  /** time spent executing app JavaScript, summed over all segments */
  cpuMs: number;
  /** total time including awaited host calls */
  wallMs: number;
  maxHostCalls: number;
  maxOutputBytes: number;
  maxLogLines: number;
}

export const DEFAULT_LIMITS: Limits = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 512 * 1024,
  cpuMs: 250,
  wallMs: 30_000,
  maxHostCalls: 64,
  maxOutputBytes: 1_000_000,
  maxLogLines: 100,
};

/** A failure the platform raises on purpose; its code reaches the caller unchanged. */
export class HostError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Host operations, keyed by name. Each gets the decoded payload and returns a JSON-able value. */
export type Host = (op: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;

export interface Invocation {
  code: string;
  handler: string;
  input: unknown;
  /** read-only facts about the viewer and the app, frozen into ctx */
  context: Record<string, unknown>;
  host: Host;
  limits?: Partial<Limits>;
}

/** A request the handler made of the platform by returning ctx.llm.stream(...) or ctx.confirm(...). */
export type Directive = { kind: "stream"; id: string } | { kind: "confirm"; request: unknown };

export interface Outcome {
  ok: boolean;
  value?: unknown;
  directive?: Directive;
  error?: { code: ErrorCode; message: string };
  stats: { cpuMs: number; wallMs: number; hostCalls: number; startMs: number };
  logs: string[];
}

// The package's types describe a CommonJS default; Node loads its ES build. Accept either shape.
const variant = ((variantModule as unknown as { default?: QuickJSSyncVariant }).default ?? variantModule) as QuickJSSyncVariant;

let modulePromise: Promise<QuickJSWASMModule> | undefined;
/** The WebAssembly module is compiled once per process; each invocation gets its own runtime. */
export const quickjs = () => {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
};

/**
 * The prelude builds ctx around the one host function and removes every other way out.
 * It runs before app code, in the same realm.
 */
const PRELUDE = (nonce: string) => `
const host = globalThis.__host;
delete globalThis.__host;
const call = (op, payload) => host(op, JSON.stringify(payload === undefined ? null : payload)).then((s) => JSON.parse(s));
const ctxFacts = JSON.parse(globalThis.__facts); delete globalThis.__facts;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };
const marker = (kind, body) => Object.freeze({ $foundry: kind, nonce: ${JSON.stringify(nonce)}, ...body });
globalThis.__ctx = Object.freeze({
  ...deepFreeze(ctxFacts),
  now: () => ctxFacts.now,
  log: (...parts) => { call("log", parts.map((p) => typeof p === "string" ? p : JSON.stringify(p)).join(" ")); },
  llm: Object.freeze({
    chat: (req) => call("llm.chat", req),
    stream: (req) => call("llm.stream", req).then((r) => marker("stream", { id: r.id })),
  }),
  connectors: Object.freeze({ call: (id, args) => call("connector", { id, args: args === undefined ? {} : args }) }),
  store: Object.freeze({
    get: (collection, key) => call("store.get", { collection, key }),
    put: (collection, key, value) => call("store.put", { collection, key, value }),
    list: (collection, opts) => call("store.list", { collection, ...(opts || {}) }),
    delete: (collection, key) => call("store.delete", { collection, key }),
  }),
  confirm: (req) => marker("confirm", { request: req }),
});
// eval and new Function stay available: code they build runs in this same realm with the same
// capabilities, so blocking them would protect nothing. The boundary is the host function.
`;

/** Run one handler. Never throws: every failure becomes an Outcome with a stable code. */
export const runHandler = async (inv: Invocation): Promise<Outcome> => {
  const limits = { ...DEFAULT_LIMITS, ...inv.limits };
  const t0 = performance.now();
  const logs: string[] = [];
  const abort = new AbortController();
  const nonce = randomBytes(12).toString("hex");
  let hostCalls = 0;
  let cpu = 0;
  let segment = 0;
  let rt: QuickJSRuntime | undefined;
  let vm: QuickJSContext | undefined;
  let cleanup = () => {};
  const held: QuickJSHandle[] = [];
  const stats = () => ({ cpuMs: round(cpu), wallMs: round(performance.now() - t0), hostCalls, startMs: startMs });
  let startMs = 0;
  const fail = (code: ErrorCode, message: string): Outcome => ({
    ok: false,
    error: { code, message: message.slice(0, 500) },
    stats: stats(),
    logs,
  });

  try {
    const QJS = await quickjs();
    rt = QJS.newRuntime();
    rt.setMemoryLimit(limits.memoryBytes);
    rt.setMaxStackSize(limits.stackBytes);
    // CPU is metered only while the VM runs: segments start before each entry and end after it.
    rt.setInterruptHandler(() => segment > 0 && cpu + (performance.now() - segment) > limits.cpuMs);
    vm = rt.newContext();
    const ctxVm = vm;

    // settled host results waiting to be delivered into the VM
    const pending = new Set<Promise<void>>();
    const deferreds = new Set<{ alive: boolean; dispose: () => void }>();
    cleanup = () => {
      for (const d of deferreds) if (d.alive) d.dispose();
    };
    const platformErrors = new Map<string, ErrorCode>();

    const hostFn = vm.newFunction("__host", (opH, payloadH) => {
      const op = ctxVm.getString(opH);
      const raw = ctxVm.getString(payloadH);
      const deferred = ctxVm.newPromise();
      deferreds.add(deferred);
      hostCalls += 1;
      const settle = (run: () => Promise<unknown>) => {
        const p = run()
          .then((value) => {
            if (!deferred.alive) return;
            const s = ctxVm.newString(JSON.stringify(value ?? null));
            deferred.resolve(s);
            s.dispose();
          })
          .catch((e: unknown) => {
            if (!deferred.alive) return;
            const code: ErrorCode = e instanceof HostError ? e.code : "UPSTREAM_ERROR";
            const message = e instanceof Error ? e.message : String(e);
            const tag = randomBytes(8).toString("hex");
            platformErrors.set(tag, code);
            const err = ctxVm.newError({ name: "PlatformError", message: `${code}: ${message}` });
            const codeH = ctxVm.newString(code);
            const tagH = ctxVm.newString(tag);
            ctxVm.setProp(err, "code", codeH);
            ctxVm.setProp(err, "__tag", tagH);
            codeH.dispose();
            tagH.dispose();
            deferred.reject(err);
            err.dispose();
          })
          .finally(() => pending.delete(p));
        pending.add(p);
      };
      if (hostCalls > limits.maxHostCalls) {
        settle(() => Promise.reject(new HostError("SANDBOX_LIMIT", `more than ${limits.maxHostCalls} platform calls in one invocation`)));
      } else if (op === "log") {
        settle(async () => {
          if (logs.length < limits.maxLogLines) logs.push(String(JSON.parse(raw)).slice(0, 2000));
          return null;
        });
      } else {
        settle(() => inv.host(op, JSON.parse(raw), abort.signal));
      }
      return deferred.handle;
    });
    vm.setProp(vm.global, "__host", hostFn);
    hostFn.dispose();
    const facts = vm.newString(JSON.stringify(inv.context));
    vm.setProp(vm.global, "__facts", facts);
    facts.dispose();

    const enter = <T>(f: () => T): T => {
      segment = performance.now();
      try {
        return f();
      } finally {
        cpu += performance.now() - segment;
        segment = 0;
      }
    };
    const errorOf = (h: QuickJSHandle): Outcome => {
      const d = ctxVm.dump(h) as { name?: string; message?: string; __tag?: string; code?: string } | undefined;
      h.dispose();
      const msg = String(d?.message ?? d ?? "error");
      if (d?.__tag && platformErrors.has(d.__tag)) return fail(platformErrors.get(d.__tag) as ErrorCode, msg);
      if (msg === "interrupted") return fail("SANDBOX_TIMEOUT", `the handler used more than ${limits.cpuMs} ms of CPU`);
      if (msg.includes("out of memory")) return fail("SANDBOX_MEMORY", `the handler used more than ${limits.memoryBytes >> 20} MiB`);
      if (d?.name === "RangeError" && msg.includes("stack")) return fail("SANDBOX_MEMORY", "the handler exceeded the stack size");
      return fail("APP_ERROR", `${d?.name ?? "Error"}: ${msg}`);
    };

    const prelude = enter(() => ctxVm.evalCode(PRELUDE(nonce), "prelude.js"));
    if (prelude.error) return errorOf(prelude.error);
    prelude.value.dispose();

    const mod = enter(() => ctxVm.evalCode(inv.code, "app.js", { type: "module" }));
    if (mod.error) return errorOf(mod.error);
    // a module evaluates to a promise of its namespace
    const nsState = ctxVm.getPromiseState(mod.value);
    if (nsState.type === "rejected") {
      mod.value.dispose();
      return errorOf(nsState.error);
    }
    // getPromiseState hands back the same handle when the value is not a promise
    const ns = nsState.type === "fulfilled" ? nsState.value : mod.value;
    if (nsState.type === "fulfilled" && !nsState.notAPromise) mod.value.dispose();
    const fn = ctxVm.getProp(ns, inv.handler);
    ns.dispose();
    if (ctxVm.typeof(fn) !== "function") {
      fn.dispose();
      return fail("UNKNOWN_HANDLER", `the app does not export a function named ${inv.handler}`);
    }

    const inputStr = ctxVm.newString(JSON.stringify(inv.input ?? null));
    const jsonObj = ctxVm.getProp(ctxVm.global, "JSON");
    held.push(jsonObj);
    const parse = ctxVm.getProp(jsonObj, "parse");
    const inputH = ctxVm.unwrapResult(ctxVm.callFunction(parse, ctxVm.undefined, inputStr));
    inputStr.dispose();
    parse.dispose();
    const ctxH = ctxVm.getProp(ctxVm.global, "__ctx");
    startMs = round(performance.now() - t0);
    const called = enter(() => ctxVm.callFunction(fn, ctxVm.undefined, inputH, ctxH));
    fn.dispose();
    inputH.dispose();
    ctxH.dispose();
    if (called.error) return errorOf(called.error);
    let result = called.value;

    // Drive the VM's job queue and the host calls until the handler's promise settles.
    const deadline = t0 + limits.wallMs;
    for (;;) {
      const jobs = enter(() => rt?.executePendingJobs());
      if (jobs?.error) return errorOf(jobs.error);
      const state = ctxVm.getPromiseState(result);
      if (state.type === "fulfilled") {
        if (state.notAPromise) break;
        result.dispose();
        result = state.value;
        break;
      }
      if (state.type === "rejected") {
        result.dispose();
        return errorOf(state.error);
      }
      if (pending.size === 0) {
        result.dispose();
        return fail("APP_ERROR", "the handler is waiting on something that will never happen");
      }
      const left = deadline - performance.now();
      if (left <= 0) {
        abort.abort();
        result.dispose();
        return fail("SANDBOX_TIMEOUT", `the handler ran longer than ${limits.wallMs} ms`);
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.race(pending), new Promise((r) => (timer = setTimeout(r, left)))]);
      clearTimeout(timer);
    }

    // Results leave the VM as JSON text, never as live objects.
    const stringify = ctxVm.getProp(jsonObj, "stringify");
    const json = enter(() => ctxVm.callFunction(stringify, ctxVm.undefined, result));
    result.dispose();
    stringify.dispose();
    if (json.error) return errorOf(json.error);
    const text = ctxVm.typeof(json.value) === "string" ? ctxVm.getString(json.value) : "null";
    json.value.dispose();
    if (text.length > limits.maxOutputBytes) return fail("SANDBOX_LIMIT", `the result is larger than ${limits.maxOutputBytes} bytes`);
    const value = JSON.parse(text) as unknown;
    const directive = directiveOf(value, nonce);
    return directive ? { ok: true, directive, stats: stats(), logs } : { ok: true, value, stats: stats(), logs };
  } catch (e) {
    if (process.env.SANDBOX_DEBUG) (await import("node:fs")).writeFileSync(process.env.SANDBOX_DEBUG, String((e as Error).stack));
    const msg = e instanceof Error ? e.message : String(e);
    if (/out of memory/i.test(msg)) return fail("SANDBOX_MEMORY", "the handler ran out of memory");
    return fail("APP_ERROR", msg);
  } finally {
    abort.abort();
    try {
      for (const h of held) if (h.alive) h.dispose();
      cleanup();
      vm?.dispose();
    } catch {
      // a context that ran out of memory can fail to dispose cleanly; the runtime goes with it
    }
    try {
      rt?.dispose();
    } catch {
      // see above
    }
  }
};

/**
 * A returned marker counts only with this invocation's nonce, so a lookalike that arrives as data
 * (a stored record, a model's output, another invocation's result) is returned as plain data. An
 * app that copies its own marker gains nothing: stream ids are checked against the streams this
 * invocation opened, and a confirmation still needs the viewer to confirm it.
 */
const directiveOf = (v: unknown, nonce: string): Directive | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const m = v as { $foundry?: unknown; nonce?: unknown; id?: unknown; request?: unknown };
  if (m.nonce !== nonce) return undefined;
  if (m.$foundry === "stream" && typeof m.id === "string") return { kind: "stream", id: m.id };
  if (m.$foundry === "confirm") return { kind: "confirm", request: m.request };
  return undefined;
};

const round = (n: number) => Math.round(n * 10) / 10;
