import type { Pool } from "../db/pool.js";

/** Per-day usage of one app: calls, failures, latency, tokens, cost, cache hits. */
export const appUsage = async (pool: Pool, appId: string, days: number) =>
  (
    await pool.query(
      `select to_char(date_trunc('day', at), 'YYYY-MM-DD') as day, count(*)::int as calls,
         count(*) filter (where not ok)::int as failures,
         coalesce(percentile_disc(0.95) within group (order by wall_ms), 0)::int as p95_ms,
         coalesce(sum(tokens_in), 0)::int as tokens_in, coalesce(sum(tokens_out), 0)::int as tokens_out,
         coalesce(sum(cost_micro_eur), 0)::bigint::text as cost_micro_eur, coalesce(sum(cache_hits), 0)::int as cache_hits,
         count(distinct viewer_oid)::int as viewers
       from foundry.invocations where app_id = $1 and at > now() - make_interval(days => $2)
       group by 1 order by 1`,
      [appId, days],
    )
  ).rows;

/** Platform-wide totals for the last day, by app. */
export const overview = async (pool: Pool) =>
  (
    await pool.query(
      `select app_id, count(*)::int as calls, count(*) filter (where not ok)::int as failures,
         coalesce(percentile_disc(0.95) within group (order by wall_ms), 0)::int as p95_ms,
         coalesce(sum(cost_micro_eur), 0)::bigint::text as cost_micro_eur, count(distinct viewer_oid)::int as viewers
       from foundry.invocations where at > now() - interval '1 day' and app_id not like 'preview:%'
       group by 1 order by calls desc`,
    )
  ).rows;
