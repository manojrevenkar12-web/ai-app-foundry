/**
 * Exact-match answer cache with single-flight. Only deterministic requests (temperature 0) are
 * cached, keyed by app. When the model may call tools, the answer depends on what the tools
 * returned for this viewer, so the key also carries the viewer's permission scope: an answer built
 * from one person's data is never served to someone who may not see that data.
 */
import { createHash } from "node:crypto";
import type { RedisClient } from "../redis.js";

export const cacheKey = (parts: unknown) => `cache:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;

export const createCache = (redis: RedisClient, ttlSeconds: number) => {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    },
    async set(key: string, value: unknown) {
      await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    },
    /** Identical requests arriving together share one provider call (per replica). */
    async once<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; shared: boolean }> {
      const existing = inflight.get(key) as Promise<T> | undefined;
      if (existing) return { value: await existing, shared: true };
      const p = fn().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return { value: await p, shared: false };
    },
  };
};
export type Cache = ReturnType<typeof createCache>;
