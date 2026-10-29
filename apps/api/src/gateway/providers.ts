/**
 * Model providers behind one interface. Apps name an alias ("fast", "smart"); the platform maps
 * it to a provider and model in config/catalog.yaml. The simulated provider is deterministic and
 * plans tool calls from the conversation, so the tool loop, budgets and caching are exercised in
 * tests and load tests without a network.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  model: string;
  system?: string;
  turns: Turn[];
  maxTokens: number;
  temperature: number;
  tools: ToolSpec[];
}
export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  stop: "end" | "tool_use" | "max_tokens";
}
export type StreamEvent = { type: "text"; text: string } | { type: "done"; usage: { inputTokens: number; outputTokens: number } };

export interface Provider {
  name: string;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
const inputTokens = (r: ChatRequest) =>
  estimateTokens((r.system ?? "") + r.turns.map((t) => t.content).join(" ") + JSON.stringify(r.tools.map((t) => t.inputSchema)));
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    });
  });

const CP = /\b[A-Z]{2}\*[A-Z]{3}\*E\d{3,6}\b/;

/** A deterministic model: plans tools from the question, then summarises what they returned. */
export const simulatedProvider = (o: { latencyMs?: number; msPerToken?: number } = {}): Provider => {
  const plan = (r: ChatRequest): ToolCall[] => {
    const lastUser = [...r.turns].reverse().find((t) => t.role === "user")?.content ?? "";
    const id = CP.exec(lastUser)?.[0];
    const calls: ToolCall[] = [];
    for (const t of r.tools) {
      const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
      const required = (t.inputSchema.required ?? []) as string[];
      const args: Record<string, unknown> = {};
      if ("id" in props && id) args.id = id;
      if ("chargePointId" in props && id) args.chargePointId = id;
      if ("q" in props) args.q = lastUser.replace(CP, "").slice(0, 200).trim() || "fault";
      if (required.every((k) => k in args)) calls.push({ id: `call_${calls.length + 1}`, name: t.name, args });
    }
    return calls;
  };
  const summarise = (r: ChatRequest) => {
    const lastUser = [...r.turns].reverse().find((t) => t.role === "user")?.content ?? "";
    const tools = r.turns.filter((t): t is Extract<Turn, { role: "tool" }> => t.role === "tool");
    if (!tools.length) return `[${r.model}] ${lastUser.slice(0, 160)}`;
    const parts = tools.map((t) => `${t.name}${t.isError ? " (failed)" : ""}: ${t.content.replace(/\s+/g, " ").slice(0, 160)}`);
    return `[${r.model}] ${lastUser.slice(0, 80)}\n\n${parts.map((p) => `- ${p}`).join("\n")}`;
  };
  return {
    name: "sim",
    async chat(r, signal) {
      const needsTools = r.tools.length > 0 && !r.turns.some((t) => t.role === "tool");
      const calls = needsTools ? plan(r) : [];
      const text = calls.length ? "" : summarise(r).slice(0, r.maxTokens * 4);
      const out = estimateTokens(text) + calls.length * 20;
      await sleep((o.latencyMs ?? 0) + out * (o.msPerToken ?? 0), signal);
      return { text, toolCalls: calls, usage: { inputTokens: inputTokens(r), outputTokens: out }, stop: calls.length ? "tool_use" : "end" };
    },
    async *stream(r, signal) {
      const text = summarise(r).slice(0, r.maxTokens * 4);
      await sleep(o.latencyMs ?? 0, signal);
      for (const word of text.split(/(?<= )/)) {
        await sleep(estimateTokens(word) * (o.msPerToken ?? 0), signal);
        yield { type: "text", text: word };
      }
      yield { type: "done", usage: { inputTokens: inputTokens(r), outputTokens: estimateTokens(text) } };
    },
  };
};

/** Claude through the Anthropic API (or Claude in Microsoft Foundry with a base URL). */
export const anthropicProvider = (o: { apiKey: string; baseURL?: string }): Provider => {
  const client = new Anthropic({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
  type Msg = Anthropic.MessageParam;
  const toMessages = (turns: Turn[]): Msg[] => {
    const out: Msg[] = [];
    for (const t of turns) {
      if (t.role === "user") out.push({ role: "user", content: t.content });
      else if (t.role === "assistant")
        out.push({
          role: "assistant",
          content: [
            ...(t.content ? [{ type: "text" as const, text: t.content }] : []),
            ...(t.toolCalls ?? []).map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.args })),
          ],
        });
      else {
        const block = { type: "tool_result" as const, tool_use_id: t.toolCallId, content: t.content, is_error: t.isError ?? false };
        const prev = out[out.length - 1];
        if (prev?.role === "user" && Array.isArray(prev.content)) (prev.content as unknown[]).push(block);
        else out.push({ role: "user", content: [block] });
      }
    }
    return out;
  };
  const params = (r: ChatRequest) => ({
    model: r.model,
    max_tokens: r.maxTokens,
    temperature: r.temperature,
    ...(r.system ? { system: r.system } : {}),
    messages: toMessages(r.turns),
    ...(r.tools.length
      ? {
          tools: r.tools.map((t) => ({
            name: t.name.replace(".", "__"),
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
  });
  return {
    name: "anthropic",
    async chat(r, signal) {
      const m = await client.messages.create(params(r), { signal });
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const toolCalls = m.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, name: b.name.replace("__", "."), args: b.input as Record<string, unknown> }] : [],
      );
      return {
        text,
        toolCalls,
        usage: { inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens },
        stop: m.stop_reason === "tool_use" ? "tool_use" : m.stop_reason === "max_tokens" ? "max_tokens" : "end",
      };
    },
    async *stream(r, signal) {
      const s = client.messages.stream(params(r), { signal });
      for await (const ev of s)
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text", text: ev.delta.text };
      const final = await s.finalMessage();
      yield { type: "done", usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens } };
    },
  };
};
