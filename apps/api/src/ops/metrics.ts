import { Counter, Histogram, Registry } from "prom-client";

export const createMetrics = () => {
  const registry = new Registry();
  const invocations = new Counter({
    name: "foundry_invocations_total",
    help: "App invocations by app and outcome",
    labelNames: ["app", "outcome"],
    registers: [registry],
  });
  const invocationSeconds = new Histogram({
    name: "foundry_invocation_seconds",
    help: "Invocation latency",
    labelNames: ["app"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const tokens = new Counter({
    name: "foundry_model_tokens_total",
    help: "Model tokens",
    labelNames: ["alias", "direction"],
    registers: [registry],
  });
  const cost = new Counter({
    name: "foundry_model_cost_micro_eur_total",
    help: "Model cost in micro-euros",
    labelNames: ["alias"],
    registers: [registry],
  });
  const providerCalls = new Counter({
    name: "foundry_provider_calls_total",
    help: "Calls to model providers",
    labelNames: ["alias"],
    registers: [registry],
  });
  const cache = new Counter({
    name: "foundry_model_cache_total",
    help: "Answer cache results",
    labelNames: ["result"],
    registers: [registry],
  });
  const http = new Histogram({
    name: "foundry_http_seconds",
    help: "HTTP request latency",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  return {
    registry,
    http,
    gatewayEvents: {
      onProviderCall: (alias: string, u: { inputTokens: number; outputTokens: number }, micro: number) => {
        providerCalls.inc({ alias });
        tokens.inc({ alias, direction: "in" }, u.inputTokens);
        tokens.inc({ alias, direction: "out" }, u.outputTokens);
        cost.inc({ alias }, micro);
      },
      onCache: (result: "hit" | "miss" | "shared") => cache.inc({ result }),
    },
    onInvocation: (app: string, outcome: string, seconds: number) => {
      invocations.inc({ app, outcome });
      invocationSeconds.observe({ app }, seconds);
    },
    providerCalls,
  };
};
export type Metrics = ReturnType<typeof createMetrics>;
