/**
 * The runtime's rules for each platform call an app makes. The API's host and the gate's
 * simulated host both call this, so a test that passes in the gate fails in production only if
 * the viewer, the data or the budget differ, never because the rules do.
 */
import type { Manifest } from "@foundry/contract";
import { HostError } from "@foundry/sandbox";
import type { Catalog } from "./catalog.js";
import { connectorOf } from "./catalog.js";

export const MAX_KEY = 200;
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_MESSAGES = 50;

export type CheckedCall =
  | { op: "connector"; id: string; args: Record<string, unknown> }
  | {
      op: "llm.chat" | "llm.stream";
      alias: string;
      maxTokens: number;
      temperature: number;
      system?: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      tools: string[];
    }
  | { op: "store.get" | "store.delete"; collection: string; key: string }
  | { op: "store.put"; collection: string; key: string; value: unknown }
  | { op: "store.list"; collection: string; prefix: string; limit: number };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const deny = (msg: string) => new HostError("CAPABILITY_NOT_DECLARED", msg);
const bad = (msg: string) => new HostError("INVALID_INPUT", msg);

export const checkCall = (m: Manifest, catalog: Catalog, op: string, payload: unknown): CheckedCall => {
  const p = obj(payload);
  if (op === "connector") {
    const id = String(p.id ?? "");
    if (!m.connectors.some((c) => c.id === id)) throw deny(`connector ${id} is not declared in the manifest`);
    const def = connectorOf(catalog, id);
    if (!def) throw deny(`connector ${id} does not exist on this platform`);
    if (def.access === "write")
      throw new HostError("CONFIRMATION_REQUIRED", `${id} changes data; return ctx.confirm(...) so the viewer confirms it`);
    return { op, id, args: obj(p.args) };
  }
  if (op === "llm.chat" || op === "llm.stream") {
    const alias = String(p.model ?? "");
    const use = m.models.find((x) => x.alias === alias);
    if (!use) throw deny(`model ${alias} is not declared in the manifest`);
    const maxTokens = p.maxTokens === undefined ? use.maxTokensPerCall : Number(p.maxTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > use.maxTokensPerCall)
      throw bad(`maxTokens must be 1..${use.maxTokensPerCall}`);
    const temperature = p.temperature === undefined ? 0 : Number(p.temperature);
    if (!(temperature >= 0 && temperature <= 1)) throw bad("temperature must be between 0 and 1");
    const messages = Array.isArray(p.messages) ? p.messages : [];
    if (messages.length === 0 || messages.length > MAX_MESSAGES) throw bad(`send 1..${MAX_MESSAGES} messages`);
    const clean = messages.map((x) => {
      const mm = obj(x);
      const role = mm.role === "assistant" ? "assistant" : "user";
      if (typeof mm.content !== "string") throw bad("message content must be text");
      return { role, content: mm.content } as const;
    });
    const tools = Array.isArray(p.tools) ? p.tools.map(String) : [];
    for (const t of tools) {
      if (!m.connectors.some((c) => c.id === t)) throw deny(`tool ${t} is not a declared connector`);
      if (connectorOf(catalog, t)?.access !== "read") throw deny(`tool ${t} changes data; models may only use read connectors as tools`);
    }
    if (op === "llm.stream" && tools.length) throw bad("a streamed answer cannot use tools; call llm.chat");
    return { op, alias, maxTokens, temperature, ...(typeof p.system === "string" ? { system: p.system } : {}), messages: clean, tools };
  }
  if (op.startsWith("store.")) {
    const collection = String(p.collection ?? "");
    if (!m.collections.some((c) => c.name === collection)) throw deny(`collection ${collection} is not declared in the manifest`);
    if (op === "store.list") {
      const limit = p.limit === undefined ? 50 : Number(p.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad("limit must be 1..200");
      return { op, collection, prefix: typeof p.prefix === "string" ? p.prefix : "", limit };
    }
    const key = String(p.key ?? "");
    if (!key || key.length > MAX_KEY) throw bad(`keys are 1..${MAX_KEY} characters`);
    if (op === "store.put") {
      if (JSON.stringify(p.value ?? null).length > MAX_VALUE_BYTES) throw bad(`a record is at most ${MAX_VALUE_BYTES} bytes`);
      return { op, collection, key, value: p.value ?? null };
    }
    if (op === "store.get" || op === "store.delete") return { op, collection, key };
  }
  throw deny(`${op} is not a platform capability`);
};

/** A confirmed write: the connector must be declared, exist and be a write. */
export const checkConfirm = (m: Manifest, catalog: Catalog, request: unknown) => {
  const r = obj(request);
  const id = String(r.connector ?? "");
  if (!m.connectors.some((c) => c.id === id)) throw deny(`connector ${id} is not declared in the manifest`);
  const def = connectorOf(catalog, id);
  if (!def || def.access !== "write") throw bad(`${id} is not a write connector`);
  const summary = typeof r.summary === "string" ? r.summary.slice(0, 300) : `Run ${def.title}`;
  return { id, args: obj(r.args), summary, def };
};
