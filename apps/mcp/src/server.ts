/**
 * Foundry for AI coding tools. Claude Code, Copilot or Cursor build an app as four files on the
 * developer's machine and use these tools to draft, check, try and submit it. Everything goes
 * through the platform API with the developer's token, so the same publish gate, tiers, reviews
 * and audit apply as in the console; this server holds no rules of its own.
 */
import { Bundle } from "@foundry/contract";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readBundleDir, writeBundleDir } from "./bundle.js";
import { type FoundryClient, FoundryError } from "./client.js";

interface Finding {
  rule: string;
  severity: "block" | "warn" | "info";
  message: string;
  line?: number;
  at?: string;
}
interface Report {
  ok: boolean;
  hash: string | null;
  findings: Finding[];
  tests: Array<{ name: string; ok: boolean; message: string }>;
  tier: { tier: number; reasons: string[]; approvals: { role: string | null } } | null;
}

const WHO = { "Foundry.Reviewer": "a platform reviewer", "Foundry.Builder": "a second builder" } as Record<string, string>;

/** A gate report as a model reads it best: the verdict first, then what to fix. */
export const summarise = (r: Report) => {
  const lines: string[] = [];
  lines.push(r.ok ? "PASSES the publish gate." : "BLOCKED by the publish gate.");
  if (r.tier)
    lines.push(
      r.tier.tier === 0
        ? "Tier 0: publishes without a reviewer."
        : `Tier ${r.tier.tier}: needs ${WHO[r.tier.approvals.role ?? ""] ?? "a reviewer"} (${r.tier.reasons.join("; ")}).`,
    );
  const order = { block: 0, warn: 1, info: 2 };
  for (const f of [...r.findings].sort((a, b) => order[a.severity] - order[b.severity]))
    lines.push(`- [${f.severity}] ${f.rule}${f.line ? ` (handlers.js line ${f.line})` : f.at ? ` (${f.at})` : ""}: ${f.message}`);
  for (const t of r.tests) lines.push(`- test "${t.name}": ${t.ok ? "passed" : `FAILED: ${t.message}`}`);
  if (r.hash) lines.push(`bundle hash ${r.hash}`);
  return lines.join("\n");
};

const text = (t: string, structured?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});
const failure = (e: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text:
        e instanceof FoundryError
          ? `${e.code} (${e.status}): ${e.message}${e.detail && typeof e.detail === "object" && "findings" in e.detail ? `\n${JSON.stringify((e.detail as { findings: unknown }).findings)}` : ""}`
          : `error: ${(e as Error).message}`,
    },
  ],
});
const guard =
  <A>(fn: (a: A) => Promise<ReturnType<typeof text>>) =>
  async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return failure(e);
    }
  };

const source = {
  dir: z.string().optional().describe("a directory with manifest.json, handlers.js, ui.json and tests.json"),
  bundle: z.record(z.string(), z.unknown()).optional().describe("the bundle as one object, instead of a directory"),
};
const bundleOf = (a: { dir?: string | undefined; bundle?: Record<string, unknown> | undefined }) => {
  if (a.dir) return readBundleDir(a.dir);
  if (a.bundle) return a.bundle;
  throw new Error("pass dir or bundle");
};

export const createFoundryMcp = (client: FoundryClient) => {
  const server = new McpServer(
    { name: "foundry", version: "1.0.0" },
    {
      instructions:
        "Foundry is EDRI's internal AI app platform. An app is a manifest (everything it may reach), handlers.js (runs in a sandbox, reaches data only through ctx), ui.json (screens from platform blocks) and tests.json. Read foundry://docs/building-apps first. Work in a directory: draft_app writes one, you edit the files, check_app until it passes, preview_app to try a handler on real data the user may see, then submit_app. Never try to get around a finding; change the app or tell the user what the platform does not allow.",
    },
  );

  server.registerResource(
    "building-apps",
    "foundry://docs/building-apps",
    { title: "How to build a Foundry app", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: String((await client.get("/v1/sdk/BUILDING_APPS.md")).body) }],
    }),
  );
  server.registerResource(
    "ctx-types",
    "foundry://docs/ctx.d.ts",
    { title: "TypeScript types of ctx, the handler's only way out of the sandbox", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: String((await client.get("/v1/sdk/ctx.d.ts")).body) }] }),
  );
  server.registerResource(
    "bundle-schema",
    "foundry://schema/bundle",
    { title: "JSON Schema of an app bundle", mimeType: "application/schema+json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/schema+json",
          text: JSON.stringify(z.toJSONSchema(Bundle, { io: "input", unrepresentable: "any" })),
        },
      ],
    }),
  );

  server.registerTool(
    "platform",
    {
      title: "What the platform offers",
      description: "Connectors (with access, classification and who may use them), model aliases with prices, and sandbox limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const r = (await client.get("/v1/platform")).body as Record<string, unknown>;
      return text(JSON.stringify(r, null, 2), r);
    }),
  );

  server.registerTool(
    "draft_app",
    {
      title: "Draft an app from a description",
      description: "The platform's builder drafts a bundle and runs the gate on it. With dir, writes the four files there to edit.",
      inputSchema: { description: z.string().min(10).max(2000), dir: z.string().optional() },
    },
    guard(async (a: { description: string; dir?: string | undefined }) => {
      const d = (await client.post("/v1/builder/draft", { description: a.description })).body as {
        bundle: Bundle;
        report: Report;
        generator: string;
      };
      const written = a.dir ? writeBundleDir(a.dir, d.bundle) : [];
      return text(
        `Drafted by ${d.generator}.${written.length ? ` Wrote ${written.join(", ")}.` : ""}\n${summarise(d.report)}${a.dir ? "" : `\n\n${JSON.stringify(d.bundle, null, 2)}`}`,
        { report: d.report, files: written },
      );
    }),
  );

  server.registerTool(
    "check_app",
    {
      title: "Run the publish gate",
      description:
        "Schema, code analysis, secrets, UI and manifest rules, and the app's own tests in the sandbox. Returns the review tier it needs.",
      inputSchema: source,
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { dir?: string; bundle?: Record<string, unknown> }) => {
      const r = (await client.post("/v1/check", bundleOf(a))).body as Report;
      return text(summarise(r), { report: r });
    }),
  );

  server.registerTool(
    "preview_app",
    {
      title: "Try a handler",
      description:
        "Runs one handler of an unpublished bundle as the token's owner, against data they may see, with separate storage and budget. Writes cannot be confirmed in a preview.",
      inputSchema: { ...source, handler: z.string(), input: z.record(z.string(), z.unknown()).default({}) },
    },
    guard(async (a: { dir?: string; bundle?: Record<string, unknown>; handler: string; input: Record<string, unknown> }) => {
      const r = await client.post("/v1/preview", { bundle: bundleOf(a), handler: a.handler, input: a.input });
      if (r.text !== undefined) return text(r.text, { streamed: r.text });
      return text(JSON.stringify(r.body, null, 2), r.body as Record<string, unknown>);
    }),
  );

  server.registerTool(
    "submit_app",
    {
      title: "Submit a version",
      description:
        "Submits the bundle as a new immutable version. Tier 0 versions can then be published by the owner; others wait for the reviewer their tier needs, who approves exactly this bundle.",
      inputSchema: source,
    },
    guard(async (a: { dir?: string; bundle?: Record<string, unknown> }) => {
      const r = (await client.post("/v1/apps", { bundle: bundleOf(a) })).body as {
        app: string;
        number: number;
        status: string;
        report: Report;
      };
      return text(`${r.app} version ${r.number} is ${r.status}.\n${summarise(r.report)}`, {
        app: r.app,
        number: r.number,
        status: r.status,
      });
    }),
  );

  server.registerTool(
    "app_status",
    {
      title: "Versions and reviews of an app",
      description: "Each version's status, review tier and the reviewers' decisions and comments.",
      inputSchema: { id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/) },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { id: string }) => {
      const r = (await client.get(`/v1/apps/${a.id}`)).body as {
        name: string;
        status: string;
        versions?: Array<{
          number: number;
          status: string;
          tier: number;
          decisions: Array<{ reviewer: string; decision: string; comment: string }>;
        }>;
      };
      const lines = [`${r.name}: ${r.status}`];
      for (const v of r.versions ?? [])
        lines.push(
          `- version ${v.number}: ${v.status}, tier ${v.tier}${v.decisions.map((d) => `; ${d.reviewer} ${d.decision}d${d.comment ? `: "${d.comment}"` : ""}`).join("")}`,
        );
      return text(lines.join("\n"), r as unknown as Record<string, unknown>);
    }),
  );

  return server;
};
