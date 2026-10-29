import type { Audience, Block, Collection, ConnectorDef, Handler, Manifest, ResultView, UiSpec } from "@foundry/contract";

export type { Audience, Block, Collection, ConnectorDef, Handler, Manifest, ResultView, UiSpec };

export interface Me {
  oid: string;
  name: string;
  roles: string[];
  groups: string[];
  countries: string[];
  groupsKnown: boolean;
  via: "session" | "token";
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  owner: string;
  mine: boolean;
  status: "draft" | "live" | "disabled";
  liveVersion: number | null;
  tier: 0 | 1 | 2 | null;
  audience: Audience | null;
  updatedAt: string;
}

export interface Decision {
  reviewer: string;
  decision: "approve" | "reject";
  hash: string;
  comment: string;
  at: string;
}

export interface VersionSummary {
  app_id: string;
  number: number;
  bundle_hash: string;
  tier: 0 | 1 | 2;
  status: "blocked" | "in_review" | "approved" | "live" | "superseded" | "rejected" | "withdrawn";
  created_by_name: string;
  created_at: string;
  decided_at: string | null;
  gate_ok: boolean;
  decisions: Decision[];
}

export interface AppDetail {
  id: string;
  name: string;
  description: string;
  owner: string;
  mine?: boolean;
  status: CatalogItem["status"];
  live: {
    number: number;
    ui: UiSpec;
    handlers: Handler[];
    manifest?: Manifest;
    tier?: 0 | 1 | 2;
    reach?: Pick<Manifest, "audience" | "connectors" | "models" | "collections">;
  } | null;
  versions?: VersionSummary[];
}

export interface Finding {
  rule: string;
  severity: "block" | "warn" | "info";
  message: string;
  at?: string;
  line?: number;
  column?: number;
}
export interface GateReport {
  ok: boolean;
  hash: string | null;
  findings: Finding[];
  tests: Array<{ name: string; ok: boolean; message: string; ms: number }>;
  tier: { tier: 0 | 1 | 2; reasons: string[]; approvals: { count: number; role: string | null } } | null;
  capabilities: {
    audience: Audience;
    connectors: Array<{ id: string; title: string; access: string; classification: string; external: boolean }>;
    models: Manifest["models"];
    collections: Collection[];
    budget: Manifest["budget"];
  } | null;
  ms: number;
}

export interface Bundle {
  manifest: Manifest;
  code: string;
  ui: UiSpec;
  tests: Array<{ name: string; handler: string; input: unknown; expect: { contains?: string[]; errorCode?: string } }>;
}

export interface VersionDetail extends Omit<VersionSummary, "gate_ok"> {
  bundle: Bundle;
  gate: GateReport;
  liveBundle: Bundle | null;
}

export interface Platform {
  connectors: Array<Omit<ConnectorDef, "example">>;
  models: Array<{ alias: string; eurPerMillionIn: number; eurPerMillionOut: number }>;
  limits: Record<string, number>;
  builder: string;
}

export interface Draft {
  bundle: Bundle;
  report: GateReport;
  generator: string;
  attempts: number;
}

export interface ReviewItem {
  app_id: string;
  number: number;
  tier: 0 | 1 | 2;
  created_by_name: string;
  created_at: string;
  bundle_hash: string;
  name: string;
}

export interface UsageDay {
  day: string;
  calls: number;
  failures: number;
  /** null on days without calls */
  p95_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_micro_eur: string;
  cache_hits: number;
  viewers: number;
}

export interface OverviewRow {
  app_id: string;
  calls: number;
  failures: number;
  p95_ms: number;
  cost_micro_eur: string;
  viewers: number;
}

export interface AuditRow {
  seq: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  hash: string;
}

export interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Persona {
  key: string;
  name: string;
  title: string;
  roles: string[];
  groups: string[];
}
