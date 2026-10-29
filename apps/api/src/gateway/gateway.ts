/**
 * The model gateway. Apps reach models only through here: the app's budget and the viewer's
 * daily share are reserved before every provider call and settled after it; tools the model asks
 * for run as the viewer through the connectors; deterministic answers are cached.
 */
import type { ModelAliasDef } from "@foundry/contract";
import type { Catalog } from "@foundry/gate";
import { HostError } from "@foundry/sandbox";
import type { Connectors } from "../connectors/registry.js";
import type { Principal } from "../identity/principal.js";
import { type Cache, cacheKey } from "./cache.js";
import type { Limits } from "./limits.js";
import { estimateTokens, type Provider, type StreamEvent, type ToolSpec, type Turn } from "./providers.js";

export const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 8000;

export interface AppBudget {
  appId: string;
  eurPerDay: number;
  tokensPerUserPerDay: number;
}
export interface ChatInput {
  app: AppBudget;
  viewer: Principal;
  alias: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature: number;
  tools: string[];
  signal: AbortSignal;
}
export interface ChatOutput {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: Array<{ tool: string; ok: boolean }>;
  costMicroEur: number;
  cacheHit: boolean;
  providerCalls: number;
}

export interface GatewayEvents {
  onProviderCall?: (alias: string, usage: { inputTokens: number; outputTokens: number }, microEur: number) => void;
  onCache?: (result: "hit" | "miss" | "shared") => void;
}

/** micro-euros for a token count: prices are per million tokens */
export const costOf = (m: ModelAliasDef, inTok: number, outTok: number) => inTok * m.eurPerMillionIn + outTok * m.eurPerMillionOut;

export const createGateway = (d: {
  catalog: Catalog;
  providers: Record<string, Provider>;
  limits: Limits;
  cache: Cache;
  connectors: Connectors;
  events?: GatewayEvents;
}) => {
  const resolve = (alias: string) => {
    const def = d.catalog.models.find((m) => m.alias === alias);
    const provider = def && d.providers[def.provider];
    if (!def || !provider) throw new HostError("UPSTREAM_ERROR", `model ${alias} is not configured`);
    return { def, provider };
  };

  const budgeted = async <T>(
    o: ChatInput,
    def: ModelAliasDef,
    inTokEst: number,
    call: () => Promise<{ value: T; usage: { inputTokens: number; outputTokens: number } }>,
  ) => {
    const r = await d.limits.reserve({
      appId: o.app.appId,
      viewerOid: o.viewer.oid,
      microEur: costOf(def, inTokEst, o.maxTokens),
      tokens: inTokEst + o.maxTokens,
      appLimitMicroEur: o.app.eurPerDay * 1e6,
      userLimitTokens: o.app.tokensPerUserPerDay,
    });
    if (!r.ok) throw new HostError("BUDGET_EXHAUSTED", r.reason);
    try {
      const out = await call();
      const micro = costOf(def, out.usage.inputTokens, out.usage.outputTokens);
      await d.limits.settle(r.reservation, { microEur: micro, tokens: out.usage.inputTokens + out.usage.outputTokens });
      d.events?.onProviderCall?.(def.alias, out.usage, micro);
      return { ...out, microEur: micro };
    } catch (e) {
      await d.limits.settle(r.reservation, { microEur: 0, tokens: 0 });
      throw e;
    }
  };

  const toolSpecs = (ids: string[]): ToolSpec[] =>
    ids.map((id) => {
      const def = d.connectors.def(id);
      return {
        name: id,
        description: def ? `${def.title}. ${def.description}` : id,
        inputSchema: d.connectors.toolSchema(id) as Record<string, unknown>,
      };
    });

  const run = async (o: ChatInput): Promise<ChatOutput> => {
    const { def, provider } = resolve(o.alias);
    const tools = toolSpecs(o.tools);
    const turns: Turn[] = o.messages.map((m) => ({ role: m.role, content: m.content }));
    const usage = { inputTokens: 0, outputTokens: 0 };
    const calls: ChatOutput["toolCalls"] = [];
    let micro = 0;
    let providerCalls = 0;
    for (let round = 0; ; round++) {
      const offerTools = round < MAX_TOOL_ROUNDS ? tools : [];
      const req = {
        model: def.model,
        ...(o.system ? { system: o.system } : {}),
        turns,
        maxTokens: o.maxTokens,
        temperature: o.temperature,
        tools: offerTools,
      };
      const est = estimateTokens((o.system ?? "") + turns.map((t) => t.content).join(" ")) + 50;
      const res = await budgeted(o, def, est, async () => {
        const v = await provider.chat(req, o.signal);
        return { value: v, usage: v.usage };
      });
      providerCalls += 1;
      micro += res.microEur;
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      const r = res.value;
      if (r.toolCalls.length === 0 || offerTools.length === 0)
        return { text: r.text, usage, toolCalls: calls, costMicroEur: Math.round(micro), cacheHit: false, providerCalls };
      turns.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
      for (const c of r.toolCalls) {
        if (!o.tools.includes(c.name)) {
          turns.push({ role: "tool", toolCallId: c.id, name: c.name, content: `${c.name} is not available to this app`, isError: true });
          calls.push({ tool: c.name, ok: false });
          continue;
        }
        try {
          const out = await d.connectors.call(c.name, c.args, { viewer: o.viewer, appId: o.app.appId, signal: o.signal });
          turns.push({ role: "tool", toolCallId: c.id, name: c.name, content: JSON.stringify(out).slice(0, MAX_TOOL_RESULT_CHARS) });
          calls.push({ tool: c.name, ok: true });
        } catch (e) {
          // the model sees the refusal, not the data: a forbidden tool stays forbidden
          turns.push({ role: "tool", toolCallId: c.id, name: c.name, content: `error: ${(e as Error).message}`, isError: true });
          calls.push({ tool: c.name, ok: false });
        }
      }
    }
  };

  return {
    async chat(o: ChatInput): Promise<ChatOutput> {
      if (o.temperature !== 0) return run(o);
      const { def } = resolve(o.alias);
      const scope = o.tools.length ? { groups: o.viewer.groups, countries: o.viewer.countries, known: o.viewer.groupsKnown } : null;
      const key = cacheKey({
        v: 1,
        app: o.app.appId,
        model: def.model,
        system: o.system ?? "",
        messages: o.messages,
        maxTokens: o.maxTokens,
        tools: o.tools,
        scope,
      });
      const hit = await d.cache.get<ChatOutput>(key);
      if (hit) {
        d.events?.onCache?.("hit");
        return { ...hit, cacheHit: true, costMicroEur: 0, providerCalls: 0 };
      }
      const { value, shared } = await d.cache.once(key, async () => {
        const out = await run(o);
        await d.cache.set(key, out);
        return out;
      });
      d.events?.onCache?.(shared ? "shared" : "miss");
      return shared ? { ...value, cacheHit: true, costMicroEur: 0, providerCalls: 0 } : value;
    },

    /** A streamed answer (no tools). Budget is reserved up front and settled when the stream ends. */
    async *stream(o: ChatInput): AsyncGenerator<StreamEvent & { costMicroEur?: number }> {
      const { def, provider } = resolve(o.alias);
      const turns: Turn[] = o.messages.map((m) => ({ role: m.role, content: m.content }));
      const est = estimateTokens((o.system ?? "") + turns.map((t) => t.content).join(" ")) + 50;
      const r = await d.limits.reserve({
        appId: o.app.appId,
        viewerOid: o.viewer.oid,
        microEur: costOf(def, est, o.maxTokens),
        tokens: est + o.maxTokens,
        appLimitMicroEur: o.app.eurPerDay * 1e6,
        userLimitTokens: o.app.tokensPerUserPerDay,
      });
      if (!r.ok) throw new HostError("BUDGET_EXHAUSTED", r.reason);
      let settled = false;
      let streamed = 0;
      try {
        for await (const ev of provider.stream(
          {
            model: def.model,
            ...(o.system ? { system: o.system } : {}),
            turns,
            maxTokens: o.maxTokens,
            temperature: o.temperature,
            tools: [],
          },
          o.signal,
        )) {
          if (ev.type === "done") {
            const micro = costOf(def, ev.usage.inputTokens, ev.usage.outputTokens);
            await d.limits.settle(r.reservation, { microEur: micro, tokens: ev.usage.inputTokens + ev.usage.outputTokens });
            settled = true;
            d.events?.onProviderCall?.(def.alias, ev.usage, micro);
            yield { ...ev, costMicroEur: Math.round(micro) };
          } else {
            streamed += estimateTokens(ev.text);
            yield ev;
          }
        }
      } finally {
        // a viewer who leaves mid-answer still used what was generated so far
        if (!settled) await d.limits.settle(r.reservation, { microEur: costOf(def, est, streamed), tokens: est + streamed });
      }
    },
  };
};
export type Gateway = ReturnType<typeof createGateway>;
