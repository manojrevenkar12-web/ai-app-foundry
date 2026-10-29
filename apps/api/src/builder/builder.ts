/**
 * "Describe the app you need." Produces a bundle and runs the gate on it. With an Anthropic key,
 * Claude writes the bundle through a tool whose input schema is the bundle contract, reads the
 * gate's findings and tries again (at most three attempts). Without one, a template generator
 * covers the common shapes. Either way the result is a proposal: it is checked, previewed and
 * reviewed like anything a person wrote.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Bundle } from "@foundry/contract";
import { type Catalog, type GateReport, runGate } from "@foundry/gate";
import { z } from "zod";

export interface Draft {
  bundle: unknown;
  report: GateReport;
  generator: string;
  attempts: number;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/^[^a-z]+/, "") || "my-app";

const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

/** Deterministic drafts for the shapes most requests take: an assistant over connectors, a lookup form, a notebook. */
export const templateDraft = (description: string, groups: string[]): unknown => {
  const d = description.trim();
  // the name is the description's first clause, at most five words: "An assistant for field technicians"
  const clause = (d.split(/[.!?:;,\n]/)[0] ?? d).trim();
  const words = clause.split(/\s+/).slice(0, 5).join(" ");
  const id = slug(words) || "my-app";
  const audience = groups.includes("EDRI-Ops") ? { kind: "groups", groups: ["EDRI-Ops"] } : { kind: "owner" };
  const name = (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 58) || "My app";
  const desc = d.length >= 10 ? d.slice(0, 480) : `${d} (a draft made from a short description)`;

  if (has(d, /\b(note|notes|handover|journal|remember|log)\b/))
    return {
      manifest: {
        id,
        name,
        description: desc,
        audience: { kind: "owner" },
        handlers: [
          {
            name: "save",
            description: "Keep a note",
            input: { type: "object", properties: { text: { type: "string", maxLength: 4000 } }, required: ["text"] },
          },
          { name: "recent", description: "Your recent notes", input: { type: "object", properties: {} } },
        ],
        models: [],
        connectors: [],
        collections: [{ name: "notes", scope: "private", classification: "internal", retentionDays: 90 }],
        budget: { eurPerDay: 1, tokensPerUserPerDay: 1000 },
      },
      code: `export async function save(input, ctx) {\n  const key = ctx.now();\n  await ctx.store.put("notes", key, { at: key, text: input.text });\n  return { saved: key };\n}\n\nexport async function recent(_input, ctx) {\n  const items = await ctx.store.list("notes", { limit: 20 });\n  return { rows: items.map((i) => i.value).reverse() };\n}\n`,
      ui: {
        pages: [
          {
            id: "notes",
            title: "Notes",
            blocks: [
              {
                type: "form",
                handler: "save",
                fields: [{ name: "text", label: "Note", kind: "textarea", required: true }],
                submitLabel: "Save note",
                result: [{ type: "markdown", path: "saved" }],
              },
              {
                type: "view",
                handler: "recent",
                title: "Recent notes",
                result: [
                  {
                    type: "table",
                    path: "rows",
                    columns: [
                      { key: "at", label: "Written", format: "datetime" },
                      { key: "text", label: "Note" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      tests: [
        { name: "saves a note", handler: "save", input: { text: "Check DE*EDR*E1001 tomorrow" }, expect: { contains: ["saved"] } },
        { name: "lists notes", handler: "recent", input: {}, expect: { contains: ["rows"] } },
      ],
    };

  const tools: string[] = [];
  if (has(d, /fault|error|trip|faulted|diagnos|broken|offline|why/))
    tools.push("chargepoints.status", "chargepoints.events", "faults.diagnose", "docs.search");
  if (has(d, /ticket|technician|visit/)) tools.push("tickets.search");
  if (has(d, /runbook|manual|how (do|to)|procedure/)) tools.push("docs.search");
  if (has(d, /status|available|city|site|where/)) tools.push("chargepoints.search");
  const unique = [...new Set(tools)];
  if (unique.length === 0) unique.push("docs.search");
  return {
    manifest: {
      id,
      name,
      description: desc,
      audience,
      handlers: [
        {
          name: "ask",
          description: "Answer a question",
          input: {
            type: "object",
            properties: {
              message: { type: "string", maxLength: 2000 },
              history: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string", maxLength: 4000 } },
                },
              },
            },
            required: ["message"],
          },
        },
      ],
      models: [{ alias: "smart", maxTokensPerCall: 1000 }],
      connectors: unique.map((c) => ({ id: c })),
      collections: [],
      budget: { eurPerDay: 10, tokensPerUserPerDay: 100000 },
    },
    code: `const SYSTEM = ${JSON.stringify(`You help EDRI colleagues with this task: ${d.slice(0, 300)}\nUse the tools for facts and say which tool each fact came from. If the tools do not answer the question, say so.`)};\n\nexport async function ask(input, ctx) {\n  const messages = [...(input.history || []).slice(-10), { role: "user", content: input.message }];\n  const r = await ctx.llm.chat({ model: "smart", system: SYSTEM, messages, tools: ${JSON.stringify(unique)}, maxTokens: 1000 });\n  return { reply: r.text, sources: r.toolCalls.map((c) => c.tool) };\n}\n`,
    ui: {
      pages: [
        {
          id: "assistant",
          title: "Assistant",
          blocks: [{ type: "chat", handler: "ask", intro: desc.slice(0, 380), placeholder: "Ask a question", suggestions: [] }],
        },
      ],
    },
    tests: [
      {
        name: "answers a question",
        handler: "ask",
        input: { message: "What is wrong with DE*EDR*E1001?" },
        expect: { contains: ["reply"] },
      },
    ],
  };
};

/** The SDK documents builders and their coding tools read; the platform serves them so they match its version. */
export const SDK_FILES: Record<string, { type: string; text: string }> = (() => {
  const dir = new URL("../../../../packages/sdk/", import.meta.url);
  const read = (f: string) => {
    try {
      return readFileSync(new URL(f, dir), "utf8");
    } catch {
      return "";
    }
  };
  return {
    "BUILDING_APPS.md": { type: "text/markdown; charset=utf-8", text: read("BUILDING_APPS.md") },
    "ctx.d.ts": { type: "text/plain; charset=utf-8", text: read("ctx.d.ts") },
  };
})();
const SDK = SDK_FILES["BUILDING_APPS.md"]?.text
  ? `${SDK_FILES["BUILDING_APPS.md"].text}\n\nctx.d.ts:\n${SDK_FILES["ctx.d.ts"]?.text ?? ""}`
  : "";

export const createBuilder = (d: { catalog: Catalog; anthropicKey?: string; model?: string }) => {
  const client = d.anthropicKey ? new Anthropic({ apiKey: d.anthropicKey }) : null;
  const model = d.model ?? "claude-sonnet-5-5";
  const schema = z.toJSONSchema(Bundle, { io: "input", unrepresentable: "any" }) as Anthropic.Tool.InputSchema;
  const catalogText = d.catalog.connectors
    .map(
      (c) =>
        `- ${c.id} (${c.access}, ${c.classification}, groups: ${c.allowedGroups.join("/")}): ${c.title}. ${c.description} args: ${JSON.stringify(c.args)}`,
    )
    .join("\n");
  const system = `You write apps for EDRI's internal AI platform. Produce a complete bundle with the submit_app tool.\n\n${SDK}\n\nConnectors on this platform:\n${catalogText}\n\nModel aliases: fast, smart. Keep budgets modest. Include at least one test per handler.`;

  return {
    generator: client ? `claude:${model}` : "template",
    async draft(description: string, viewerGroups: string[]): Promise<Draft> {
      if (!client) {
        const bundle = templateDraft(description, viewerGroups);
        return { bundle, report: await runGate(bundle, d.catalog), generator: "template", attempts: 1 };
      }
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Build this app: ${description}` }];
      let last: Draft | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await client.messages.create({
          model,
          max_tokens: 8000,
          system,
          messages,
          tools: [{ name: "submit_app", description: "Submit the app bundle for checking", input_schema: schema }],
          tool_choice: { type: "tool", name: "submit_app" },
        });
        const use = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (!use) break;
        const report = await runGate(use.input, d.catalog);
        last = { bundle: use.input, report, generator: `claude:${model}`, attempts: attempt };
        if (report.ok) return last;
        const problems = [
          ...report.findings
            .filter((f) => f.severity === "block")
            .map((f) => `${f.rule}: ${f.message}${f.line ? ` (line ${f.line})` : ""}`),
          ...report.tests.filter((t) => !t.ok).map((t) => `test "${t.name}": ${t.message}`),
        ];
        messages.push({ role: "assistant", content: res.content });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: use.id,
              is_error: true,
              content: `The gate blocked this bundle:\n${problems.join("\n")}\nFix these and submit again.`,
            },
          ],
        });
      }
      if (last) return last;
      const bundle = templateDraft(description, viewerGroups);
      return { bundle, report: await runGate(bundle, d.catalog), generator: "template (the model returned no bundle)", attempts: 3 };
    },
  };
};
export type Builder = ReturnType<typeof createBuilder>;
