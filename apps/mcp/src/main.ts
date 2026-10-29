#!/usr/bin/env node
/** stdio entry point: FOUNDRY_URL and FOUNDRY_TOKEN (a personal token from the console's Tokens page). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./client.js";
import { createFoundryMcp } from "./server.js";

const url = process.env.FOUNDRY_URL;
const token = process.env.FOUNDRY_TOKEN;
if (!url || !token?.startsWith("fdy_")) {
  process.stderr.write("set FOUNDRY_URL and FOUNDRY_TOKEN (create a token on the console's Tokens page)\n");
  process.exit(2);
}
await createFoundryMcp(createClient({ url, token })).connect(new StdioServerTransport());
