/**
 * Publishes the example apps for a development system: each is submitted by its builder,
 * approved by someone else where its tier needs it, and published. Needs DEV_IDP=on.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Bundle } from "@foundry/contract";
import { loadBundleDir } from "@foundry/gate";
import { loadConfig } from "../config.js";
import { PERSONAS } from "../identity/dev-idp.js";
import type { Principal } from "../identity/principal.js";
import { createServer } from "../server.js";

const OWNERS: Record<string, string> = { "revenue-brief": "sofia" };

const config = loadConfig();
if (!config.DEV_IDP) throw new Error("seed-apps runs only against the development identity provider (DEV_IDP=on)");
const s = await createServer(config);
const dev = s.deps.dev;
if (!dev) throw new Error("no dev IdP");
const who = async (key: string): Promise<Principal> => {
  const p = PERSONAS.find((x) => x.key === key);
  if (!p) throw new Error(key);
  return { ...(await s.deps.validateEntraToken(await dev.accessToken(p))), via: "session" };
};
const reviewer = await who("lea");
const peer = await who("mara");
const dir = resolve(process.env.EXAMPLES_DIR ?? "../../examples/apps");
const out: Array<Record<string, unknown>> = [];
for (const name of readdirSync(dir)) {
  const bundle = Bundle.parse(loadBundleDir(`${dir}/${name}`));
  const owner = await who(OWNERS[name] ?? "mara");
  const existing = await s.deps.registry.app(bundle.manifest.id);
  if (existing?.live_version) {
    out.push({ app: name, skipped: "already live" });
    continue;
  }
  const v = await s.deps.registry.submit(owner, bundle);
  if (v.status === "in_review") {
    const by = v.report.tier?.approvals.role === "Foundry.Reviewer" || owner.oid === peer.oid ? reviewer : peer;
    await s.deps.registry.decide(by, v.app, v.number, "approve", v.report.hash as string, "seeded for development");
  }
  await s.deps.registry.publish(owner, v.app, v.number);
  out.push({ app: v.app, version: v.number, tier: v.report.tier?.tier, owner: owner.name });
}
console.log(JSON.stringify(out, null, 1));
await s.close();
