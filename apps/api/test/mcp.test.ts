/**
 * The MCP server an AI coding tool uses, against the real platform: a token acts as its owner,
 * and the gate, tiers and data rules are the platform's, not the MCP server's.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createFoundryMcp } from "@foundry/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropDatabase, faultModelStub, freshDatabase, persona, type Server, startServer } from "./helpers.js";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let s: Server;
let stub: Awaited<ReturnType<typeof faultModelStub>>;

const connect = async (token: string) => {
  const api = createClient({
    url: "http://foundry.test",
    token,
    fetch: ((url: string, init?: RequestInit) => s.app.request(url, init)) as typeof fetch,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createFoundryMcp(api).connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return client;
};
const tokenFor = async (key: string, scopes: string[]) => {
  const dev = s.deps.dev;
  if (!dev) throw new Error("dev idp off");
  const p = await s.deps.validateEntraToken(await dev.accessToken(persona(key)));
  return (await s.deps.tokens.issue({ ...p, via: "session" }, "mcp test", scopes as never, 1)).token;
};
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;

beforeAll(async () => {
  db = await freshDatabase(200);
  stub = await faultModelStub();
  s = await startServer(db, {}, stub.url);
});
afterAll(async () => {
  await s?.close();
  stub?.close();
  if (db) await dropDatabase(db.name);
});

describe("the MCP server for coding tools", () => {
  it("offers the tools and the platform's own documents", async () => {
    const c = await connect(await tokenFor("mara", ["apps:read", "apps:write"]));
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "app_status",
      "check_app",
      "draft_app",
      "platform",
      "preview_app",
      "submit_app",
    ]);
    const doc = await c.readResource({ uri: "foundry://docs/building-apps" });
    expect((doc.contents[0] as unknown as { text: string }).text).toContain("Handler input");
    const schema = JSON.parse(((await c.readResource({ uri: "foundry://schema/bundle" })).contents[0] as unknown as { text: string }).text);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["manifest", "code", "ui", "tests"]));
  });

  it("drafts into a directory, sees the gate block an edit, previews and submits the fixed app", async () => {
    const c = await connect(await tokenFor("mara", ["apps:read", "apps:write"]));
    const dir = mkdtempSync(join(tmpdir(), "foundry-app-"));
    const drafted = textOf(
      await c.callTool({ name: "draft_app", arguments: { description: "A private notebook for my handover notes", dir } }),
    );
    expect(drafted).toContain("PASSES the publish gate");

    // the coding tool edits handlers.js and reaches for a connector the manifest does not declare
    const code = readFileSync(join(dir, "handlers.js"), "utf8");
    writeFileSync(
      join(dir, "handlers.js"),
      `${code}\nexport async function peek(_i, ctx) { return ctx.connectors.call("sessions.revenue", {}); }\n`,
    );
    const blocked = textOf(await c.callTool({ name: "check_app", arguments: { dir } }));
    expect(blocked).toContain("BLOCKED");
    expect(blocked).toContain("sessions.revenue");

    writeFileSync(join(dir, "handlers.js"), code);
    const tried = textOf(
      await c.callTool({ name: "preview_app", arguments: { dir, handler: "save", input: { text: "check DE*EDR*E1001" } } }),
    );
    expect(tried).toContain("saved");

    const sub = await c.callTool({ name: "submit_app", arguments: { dir } });
    expect(textOf(sub)).toMatch(/version 1 is approved/);
    const id = (sub as unknown as { structuredContent: { app: string } }).structuredContent.app;
    expect(textOf(await c.callTool({ name: "app_status", arguments: { id } }))).toContain("version 1: approved, tier 0");
  });

  it("is limited by the token's scopes and its owner's roles", async () => {
    const readOnly = await connect(await tokenFor("mara", ["apps:read"]));
    const r = await readOnly.callTool({ name: "check_app", arguments: { bundle: { manifest: {} } } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("SCOPE_REQUIRED");
    // Jonas is not a builder: the platform refuses, whatever the coding tool asks
    const user = await connect(await tokenFor("jonas", ["apps:read", "apps:write"]));
    const d = await user.callTool({ name: "draft_app", arguments: { description: "Something that reads revenue" } });
    expect(d.isError).toBe(true);
    expect(textOf(d)).toContain("ROLE_REQUIRED");
  });
});
