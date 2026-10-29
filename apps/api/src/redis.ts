import { Redis } from "ioredis";

export const createRedis = (url: string) => new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true, lazyConnect: false });
export type RedisClient = Redis;
