/**
 * Every query that touches app data or operational data runs inside withScope: it sets, for this
 * transaction only, which app is asking and on whose behalf. The row-level security policies read
 * these settings; a query outside a scope sees no rows.
 */
import type { PoolClient } from "pg";
import type { Pool } from "./pool.js";

export interface Scope {
  appId?: string;
  viewerOid?: string;
  /** country codes the viewer may see, or ["*"] */
  countries: string[];
}

export const withScope = async <T>(pool: Pool, scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      "select set_config('foundry.app_id', $1, true), set_config('foundry.viewer_oid', $2, true), set_config('foundry.viewer_countries', $3, true)",
      [scope.appId ?? "", scope.viewerOid ?? "", scope.countries.join(",")],
    );
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};

export const tx = async <T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};
