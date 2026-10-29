/**
 * Sign-in as a backend-for-frontend: the browser never holds a token. The API runs the OIDC
 * authorization-code flow with PKCE against Entra, validates the access token it receives, and
 * keeps the resulting Principal in Redis behind an opaque, HttpOnly session cookie.
 */
import { createHash, randomBytes } from "node:crypto";
import type { RedisClient } from "../redis.js";
import type { Principal } from "./principal.js";

export const SESSION_TTL_S = 8 * 3600;
const STATE_TTL_S = 600;

export const COOKIE = (secure: boolean) => (secure ? "__Host-foundry" : "foundry_session");

const sessionKey = (sid: string) => `session:${createHash("sha256").update(sid).digest("hex")}`;

export const createSessions = (redis: RedisClient) => ({
  async begin(returnTo: string) {
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await redis.set(`auth:${state}`, JSON.stringify({ nonce, verifier, returnTo }), "EX", STATE_TTL_S);
    return { state, nonce, challenge };
  },
  /** One use: a replayed state is refused. */
  async finish(state: string) {
    const raw = await redis.getdel(`auth:${state}`);
    return raw ? (JSON.parse(raw) as { nonce: string; verifier: string; returnTo: string }) : null;
  },
  async create(p: Principal) {
    const sid = randomBytes(32).toString("base64url");
    await redis.set(sessionKey(sid), JSON.stringify({ ...p, via: "session" }), "EX", SESSION_TTL_S);
    return sid;
  },
  async get(sid: string): Promise<Principal | null> {
    const raw = await redis.get(sessionKey(sid));
    return raw ? (JSON.parse(raw) as Principal) : null;
  },
  async destroy(sid: string) {
    await redis.del(sessionKey(sid));
  },
});
export type Sessions = ReturnType<typeof createSessions>;

/** Only same-origin paths may follow sign-in; anything else would be an open redirect. */
export const safeReturnTo = (v: string | undefined) => (v && /^\/(?!\/)[\w\-./?=&%#]*$/.test(v) ? v : "/");
