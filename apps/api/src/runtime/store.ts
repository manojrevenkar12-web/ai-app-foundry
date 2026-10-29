/**
 * The records apps keep. Every query runs in the scope of the app and the viewer; row-level
 * security does the isolating. Private collections belong to one viewer; shared ones to everyone
 * who can open the app. Records expire after the collection's retention.
 */
import type { Collection } from "@foundry/contract";
import type { Pool } from "../db/pool.js";
import { withScope } from "../db/scope.js";

export const createStore = (pool: Pool) => {
  const scope = (appId: string, viewerOid: string) => ({ appId, viewerOid, countries: [] });
  const owner = (col: Collection, viewerOid: string) => (col.scope === "private" ? viewerOid : null);
  return {
    get: (appId: string, viewerOid: string, col: Collection, key: string) =>
      withScope(pool, scope(appId, viewerOid), async (c) => {
        const r = await c.query<{ value: unknown }>(
          "select value from foundry.app_records where app_id = $1 and collection = $2 and owner_oid is not distinct from $3 and key = $4 and expires_at > now()",
          [appId, col.name, owner(col, viewerOid), key],
        );
        return r.rows[0]?.value ?? null;
      }),
    put: (appId: string, viewerOid: string, col: Collection, key: string, value: unknown) =>
      withScope(pool, scope(appId, viewerOid), async (c) => {
        await c.query(
          `insert into foundry.app_records (app_id, collection, owner_oid, key, value, classification, expires_at)
           values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
           on conflict (app_id, collection, coalesce(owner_oid, '00000000-0000-0000-0000-000000000000'::uuid), key)
           do update set value = excluded.value, updated_at = now(), expires_at = excluded.expires_at`,
          [appId, col.name, owner(col, viewerOid), key, JSON.stringify(value), col.classification, col.retentionDays],
        );
        return null;
      }),
    list: (appId: string, viewerOid: string, col: Collection, prefix: string, limit: number) =>
      withScope(pool, scope(appId, viewerOid), async (c) => {
        const r = await c.query<{ key: string; value: unknown }>(
          `select key, value from foundry.app_records
           where app_id = $1 and collection = $2 and owner_oid is not distinct from $3 and key like $4 || '%' and expires_at > now()
           order by key limit $5`,
          [appId, col.name, owner(col, viewerOid), prefix.replace(/[\\%_]/g, (m) => `\\${m}`), limit],
        );
        return r.rows;
      }),
    delete: (appId: string, viewerOid: string, col: Collection, key: string) =>
      withScope(pool, scope(appId, viewerOid), async (c) => {
        await c.query(
          "delete from foundry.app_records where app_id = $1 and collection = $2 and owner_oid is not distinct from $3 and key = $4",
          [appId, col.name, owner(col, viewerOid), key],
        );
        return null;
      }),
    /** Removes expired records (the purge policy allows nothing else); run on a schedule. */
    purgeExpired: async () => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("select set_config('foundry.maintenance', 'purge', true)");
        const n = (await c.query("delete from foundry.app_records where expires_at <= now()")).rowCount ?? 0;
        await c.query("commit");
        return n;
      } catch (e) {
        await c.query("rollback");
        throw e;
      } finally {
        c.release();
      }
    },
  };
};
export type Store = ReturnType<typeof createStore>;
