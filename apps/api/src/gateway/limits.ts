/**
 * Budgets and rate limits, shared by every API replica through Redis. Each check-and-reserve is one
 * Lua script, so two replicas cannot both spend the last euro. Lua returns integers (Redis
 * truncates numbers), so money is held in micro-euros.
 */
import type { RedisClient } from "../redis.js";

const RESERVE = `
local appSpent = tonumber(redis.call('GET', KEYS[1]) or '0')
local userUsed = tonumber(redis.call('GET', KEYS[2]) or '0')
if appSpent + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return -1 end
if userUsed + tonumber(ARGV[3]) > tonumber(ARGV[4]) then return -2 end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('INCRBY', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[5])
return 1`;

const SETTLE = `
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('INCRBY', KEYS[2], ARGV[2])
return 1`;

const WINDOW = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if n > tonumber(ARGV[1]) then return -1 end
return n`;

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const TTL = 2 * 86_400;

export interface Reservation {
  microEur: number;
  tokens: number;
  keys: [string, string];
}

export const createLimits = (redis: RedisClient) => ({
  /** Reserve the worst case before calling a model; null with a reason when it does not fit. */
  async reserve(o: {
    appId: string;
    viewerOid: string;
    microEur: number;
    tokens: number;
    appLimitMicroEur: number;
    userLimitTokens: number;
  }) {
    const keys: [string, string] = [`budget:${o.appId}:${dayKey()}:eur`, `budget:${o.appId}:${o.viewerOid}:${dayKey()}:tok`];
    const r = (await redis.eval(
      RESERVE,
      2,
      ...keys,
      Math.ceil(o.microEur),
      Math.floor(o.appLimitMicroEur),
      Math.ceil(o.tokens),
      Math.floor(o.userLimitTokens),
      TTL,
    )) as number;
    if (r === -1) return { ok: false as const, reason: "the app has used its budget for today" };
    if (r === -2) return { ok: false as const, reason: "you have used your share of this app's tokens for today" };
    return { ok: true as const, reservation: { microEur: Math.ceil(o.microEur), tokens: Math.ceil(o.tokens), keys } };
  },
  /** Replace the reservation with what the call actually cost. */
  async settle(r: Reservation, actual: { microEur: number; tokens: number }) {
    await redis.eval(SETTLE, 2, ...r.keys, Math.round(actual.microEur) - r.microEur, Math.round(actual.tokens) - r.tokens);
  },
  async spent(appId: string) {
    return Number((await redis.get(`budget:${appId}:${dayKey()}:eur`)) ?? 0);
  },
  /** Fixed one-minute window per viewer and app. */
  async allow(appId: string, viewerOid: string, perMinute: number) {
    const minute = Math.floor(Date.now() / 60_000);
    return ((await redis.eval(WINDOW, 1, `rate:${appId}:${viewerOid}:${minute}`, perMinute, 61)) as number) > 0;
  },
});
export type Limits = ReturnType<typeof createLimits>;
