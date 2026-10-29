/** Builds the whole server from configuration. Tests build exactly what production runs. */
import { resolve } from "node:path";
import { loadCatalog } from "@foundry/gate";
import { createAudit } from "./audit/audit.js";
import { createBuilder } from "./builder/builder.js";
import type { Config } from "./config.js";
import { createConnectors } from "./connectors/registry.js";
import { createPool } from "./db/pool.js";
import { createCache } from "./gateway/cache.js";
import { createGateway } from "./gateway/gateway.js";
import { createLimits } from "./gateway/limits.js";
import { anthropicProvider, type Provider, simulatedProvider } from "./gateway/providers.js";
import { createHttp } from "./http/app.js";
import { createDevIdp } from "./identity/dev-idp.js";
import { loadDirectory } from "./identity/directory.js";
import { createEntraValidator, createGraph } from "./identity/entra.js";
import { createSessions } from "./identity/sessions.js";
import { createTokens } from "./identity/tokens.js";
import { createMetrics } from "./ops/metrics.js";
import { createRedis } from "./redis.js";
import { createRegistry } from "./registry/registry.js";
import { createRuntime } from "./runtime/runtime.js";
import { createStore } from "./runtime/store.js";

export interface ServerOptions {
  /** simulated model latency, for load tests */
  simLatencyMs?: number;
  simMsPerToken?: number;
  perMinute?: number;
  cacheTtlSeconds?: number;
}

export const createServer = async (config: Config, opts: ServerOptions = {}) => {
  const configDir = resolve(config.CONFIG_DIR);
  const catalog = loadCatalog(`${configDir}/catalog.yaml`);
  const directory = loadDirectory(`${configDir}/identity.yaml`);
  const pool = createPool(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const metrics = createMetrics();
  const audit = createAudit(pool);

  const authority = config.DEV_IDP ? `${config.PUBLIC_URL}/dev-idp` : (config.ENTRA_AUTHORITY ?? "https://login.microsoftonline.com");
  const devSecret = config.ENTRA_CLIENT_SECRET ?? "dev-client-secret";
  const dev = config.DEV_IDP
    ? await createDevIdp({
        authority,
        tenantId: directory.tenantId,
        audience: directory.audience,
        clientId: config.ENTRA_CLIENT_ID,
        clientSecret: devSecret,
        directory,
      })
    : undefined;
  const graph = dev
    ? {
        memberGroups: async (_tid: string, oid: string, signal: AbortSignal) => {
          const r = await dev.app.request(`/graph/users/${oid}/getMemberGroups`, { method: "POST", signal });
          if (!r.ok) throw new Error(`graph ${r.status}`);
          return ((await r.json()) as { value: string[] }).value;
        },
      }
    : createGraph({
        authority,
        tenantId: directory.tenantId,
        clientId: config.ENTRA_CLIENT_ID,
        clientSecret: config.ENTRA_CLIENT_SECRET ?? "",
      });
  const validateEntraToken = createEntraValidator({
    authority,
    tenantId: directory.tenantId,
    audience: directory.audience,
    directory,
    graph,
    // the dev IdP's key is in memory; production fetches Entra's published keys
    ...(dev ? { keys: async () => (await import("jose")).importJWK(dev.jwk, "RS256") as never } : {}),
  });

  const providers: Record<string, Provider> = {
    sim: simulatedProvider({ latencyMs: opts.simLatencyMs ?? 0, msPerToken: opts.simMsPerToken ?? 0 }),
  };
  if (config.ANTHROPIC_API_KEY) providers.anthropic = anthropicProvider({ apiKey: config.ANTHROPIC_API_KEY });

  const connectors = createConnectors({ pool, catalog, faultModelUrl: config.FAULT_MODEL_URL });
  const limits = createLimits(redis);
  const cache = createCache(redis, opts.cacheTtlSeconds ?? 3600);
  const gateway = createGateway({ catalog, providers, limits, cache, connectors, events: metrics.gatewayEvents });
  const registry = createRegistry({ pool, catalog, audit });
  const store = createStore(pool);
  const runtime = createRuntime({
    pool,
    registry,
    catalog,
    connectors,
    gateway,
    store,
    limits,
    audit,
    perMinute: opts.perMinute ?? 120,
    onInvocation: metrics.onInvocation,
  });
  const sessions = createSessions(redis);
  const tokens = createTokens(pool);
  const builder = createBuilder({ catalog, ...(config.ANTHROPIC_API_KEY ? { anthropicKey: config.ANTHROPIC_API_KEY } : {}) });

  const base = dev ? `${config.PUBLIC_URL}/dev-idp` : authority;
  const app = createHttp({
    config: { ...config, ENTRA_CLIENT_SECRET: config.ENTRA_CLIENT_SECRET ?? devSecret },
    pool,
    redis,
    catalog,
    registry,
    runtime,
    audit,
    sessions,
    tokens,
    builder,
    metrics,
    validateEntraToken,
    ...(dev ? { devIdp: dev.app } : {}),
    idp: {
      authorize: `${base}/${directory.tenantId}/oauth2/v2.0/authorize`,
      token: `${base}/${directory.tenantId}/oauth2/v2.0/token`,
      // the dev IdP runs in this process; Entra is called over HTTPS
      exchange: async (form) =>
        dev
          ? dev.app.request(`/${directory.tenantId}/oauth2/v2.0/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: form.toString(),
            })
          : fetch(`${base}/${directory.tenantId}/oauth2/v2.0/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: form,
              signal: AbortSignal.timeout(10_000),
            }),
    },
  });

  return {
    app,
    deps: {
      pool,
      redis,
      catalog,
      directory,
      registry,
      runtime,
      gateway,
      connectors,
      audit,
      tokens,
      sessions,
      store,
      limits,
      metrics,
      dev,
      validateEntraToken,
    },
    async close() {
      await pool.end();
      redis.disconnect();
    },
  };
};
