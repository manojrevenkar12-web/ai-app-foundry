import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type {
  AppDetail,
  AuditRow,
  CatalogItem,
  Me,
  OverviewRow,
  Persona,
  Platform,
  ReviewItem,
  TokenRow,
  UsageDay,
  VersionDetail,
} from "./types";

export const keys = {
  me: ["me"] as const,
  catalog: ["catalog"] as const,
  app: (id: string) => ["app", id] as const,
  version: (id: string, n: number) => ["version", id, n] as const,
  reviews: ["reviews"] as const,
  usage: (id: string) => ["usage", id] as const,
  overview: ["overview"] as const,
  audit: ["audit"] as const,
  auditVerify: ["audit-verify"] as const,
  tokens: ["tokens"] as const,
  platform: ["platform"] as const,
  personas: ["personas"] as const,
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>("/v1/me"), retry: false, staleTime: 60_000 });
export const useCatalog = () => useQuery({ queryKey: keys.catalog, queryFn: () => api.get<CatalogItem[]>("/v1/catalog") });
export const useApp = (id: string) => useQuery({ queryKey: keys.app(id), queryFn: () => api.get<AppDetail>(`/v1/apps/${id}`) });
export const useVersion = (id: string, n: number) =>
  useQuery({ queryKey: keys.version(id, n), queryFn: () => api.get<VersionDetail>(`/v1/apps/${id}/versions/${n}`), enabled: n > 0 });
export const useReviews = () => useQuery({ queryKey: keys.reviews, queryFn: () => api.get<ReviewItem[]>("/v1/reviews") });
export const useUsage = (id: string) =>
  useQuery({ queryKey: keys.usage(id), queryFn: () => api.get<UsageDay[]>(`/v1/apps/${id}/usage?days=14`) });
export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api.get<OverviewRow[]>("/v1/ops/overview") });
export const useAudit = () => useQuery({ queryKey: keys.audit, queryFn: () => api.get<AuditRow[]>("/v1/audit?limit=200") });
export const useAuditVerify = () =>
  useQuery({ queryKey: keys.auditVerify, queryFn: () => api.get<{ ok: boolean; records: number; brokenAt?: string }>("/v1/audit/verify") });
export const useTokens = () => useQuery({ queryKey: keys.tokens, queryFn: () => api.get<TokenRow[]>("/v1/tokens") });
export const usePlatform = () =>
  useQuery({ queryKey: keys.platform, queryFn: () => api.get<Platform>("/v1/platform"), staleTime: 600_000 });
export const usePersonas = () => useQuery({ queryKey: keys.personas, queryFn: () => api.get<Persona[]>("/auth/personas"), retry: false });
