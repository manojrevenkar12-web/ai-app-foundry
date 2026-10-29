import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = await createServer(config, {
  simLatencyMs: Number(process.env.SIM_LATENCY_MS ?? 0),
  simMsPerToken: Number(process.env.SIM_MS_PER_TOKEN ?? 0),
  perMinute: Number(process.env.INVOCATIONS_PER_MINUTE ?? 120),
});
const http = serve({ fetch: server.app.fetch, port: config.PORT, hostname: "0.0.0.0" });
console.log(JSON.stringify({ level: "info", message: `listening on :${config.PORT}`, devIdp: config.DEV_IDP }));

// purge expired app records every hour
const purge = setInterval(() => void server.deps.store.purgeExpired().catch(() => undefined), 3_600_000);
const stop = async () => {
  clearInterval(purge);
  http.close();
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
