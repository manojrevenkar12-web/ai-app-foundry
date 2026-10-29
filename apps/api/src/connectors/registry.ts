/**
 * Connectors act as the viewer, never as the app. A viewer outside a connector's groups is
 * refused; inside, every query runs in the viewer's country scope, which row-level security
 * enforces. An app can therefore never show a person data that person could not read themselves.
 */
import type { ConnectorDef } from "@foundry/contract";
import type { Catalog } from "@foundry/gate";
import { HostError } from "@foundry/sandbox";
import { z } from "zod";
import type { Pool } from "../db/pool.js";
import { withScope } from "../db/scope.js";
import type { Principal } from "../identity/principal.js";

const CP_ID = z.string().regex(/^[A-Z]{2}\*[A-Z]{3}\*E\d{3,6}$/, "a charge point id such as DE*EDR*E1001");
const COUNTRY = z.enum(["AT", "CZ", "DK", "DE", "HU", "IT", "NL", "PL", "RO", "SE", "GB"]);

/** Argument schemas; also shown to models as tool input schemas. */
export const ARGS = {
  "chargepoints.search": z
    .object({
      country: COUNTRY.optional(),
      city: z.string().max(60).optional(),
      status: z.enum(["Available", "Charging", "Faulted", "Unavailable"]).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  "chargepoints.status": z.object({ id: CP_ID }).strict(),
  "chargepoints.events": z.object({ id: CP_ID, days: z.number().int().min(1).max(30).default(7) }).strict(),
  "faults.diagnose": z.object({ id: CP_ID }).strict(),
  "tickets.search": z
    .object({
      chargePointId: CP_ID.optional(),
      q: z.string().max(200).optional(),
      status: z.enum(["open", "closed", "any"]).default("open"),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .strict(),
  "tickets.comment": z.object({ ticketId: z.string().regex(/^T-\d{1,8}$/), text: z.string().min(1).max(2000) }).strict(),
  "docs.search": z.object({ q: z.string().min(2).max(300), limit: z.number().int().min(1).max(10).default(5) }).strict(),
  "sessions.revenue": z
    .object({ country: COUNTRY.optional(), site: z.string().max(120).optional(), months: z.number().int().min(1).max(24).default(3) })
    .strict(),
  "partners.contracts": z.object({ partner: z.string().max(120).optional(), site: z.string().max(120).optional() }).strict(),
  "teams.post": z.object({ channel: z.string().min(1).max(80), text: z.string().min(1).max(4000) }).strict(),
} as const;
export type ConnectorId = keyof typeof ARGS;

export interface CallContext {
  viewer: Principal;
  appId: string;
  signal: AbortSignal;
}

export interface ConnectorDeps {
  pool: Pool;
  catalog: Catalog;
  faultModelUrl: string;
}

const forbid = (msg: string) => new HostError("FORBIDDEN_FOR_VIEWER", msg);

export const mayUse = (def: ConnectorDef, viewer: Principal) => {
  if (!viewer.groupsKnown)
    return {
      ok: false as const,
      reason: "your group membership could not be confirmed just now, so group-limited data is refused; try again later",
    };
  if (!def.allowedGroups.some((g) => viewer.groups.includes(g)))
    return { ok: false as const, reason: `${def.title} is limited to ${def.allowedGroups.join(", ")}` };
  return { ok: true as const };
};

export const createConnectors = (d: ConnectorDeps) => {
  const scope = (ctx: CallContext) => ({ appId: ctx.appId, viewerOid: ctx.viewer.oid, countries: ctx.viewer.countries });
  const q = <T extends Record<string, unknown>>(ctx: CallContext, sql: string, params: unknown[]) =>
    withScope(d.pool, scope(ctx), async (c) => (await c.query<T>(sql, params)).rows);

  const impl: Record<ConnectorId, (args: never, ctx: CallContext) => Promise<unknown>> = {
    "chargepoints.search": async (a: z.infer<(typeof ARGS)["chargepoints.search"]>, ctx) => ({
      rows: await q(
        ctx,
        `select id, site, city, country, power_kw as "powerKw", status, last_seen as "lastSeen" from ev.chargepoints
         where ($1::text is null or country = $1) and ($2::text is null or lower(city) = lower($2)) and ($3::text is null or status = $3)
         order by country, city, site, id limit $4`,
        [a.country ?? null, a.city ?? null, a.status ?? null, a.limit],
      ),
    }),
    "chargepoints.status": async (a: z.infer<(typeof ARGS)["chargepoints.status"]>, ctx) =>
      withScope(d.pool, scope(ctx), async (c) => {
        const cp = (
          await c.query(
            `select id, site, city, country, power_kw as "powerKw", vendor, model, firmware, status, last_seen as "lastSeen" from ev.chargepoints where id = $1`,
            [a.id],
          )
        ).rows[0];
        if (!cp) return { id: a.id, found: false, note: "no charge point with this id that you may see" };
        const last = (
          await c.query(
            `select distinct on (connector) connector, status, error_code as "errorCode", at from ev.status_events where cp_id = $1 order by connector, at desc`,
            [a.id],
          )
        ).rows;
        return { ...cp, found: true, connectors: last };
      }),
    "chargepoints.events": async (a: z.infer<(typeof ARGS)["chargepoints.events"]>, ctx) => ({
      id: a.id,
      events: await q(
        ctx,
        `select at, connector, status, error_code as "errorCode", vendor_error_code as "vendorErrorCode" from ev.status_events
         where cp_id = $1 and error_code <> 'NoError' and at > now() - make_interval(days => $2) order by at desc limit 200`,
        [a.id, a.days],
      ),
    }),
    "faults.diagnose": async (a: z.infer<(typeof ARGS)["faults.diagnose"]>, ctx) => {
      // the viewer must be able to see the charge point; the model service itself reads all countries
      const visible = await q(ctx, "select 1 from ev.chargepoints where id = $1", [a.id]);
      if (!visible.length) return { id: a.id, found: false, note: "no charge point with this id that you may see" };
      const res = await fetch(`${d.faultModelUrl}/diagnose/${encodeURIComponent(a.id)}`, { signal: ctx.signal }).catch(() => null);
      if (!res?.ok) throw new HostError("UPSTREAM_ERROR", "the fault model is not available");
      return res.json();
    },
    "tickets.search": async (a: z.infer<(typeof ARGS)["tickets.search"]>, ctx) => ({
      rows: await q(
        ctx,
        `select id, cp_id as "chargePointId", title, status, opened, closed, technician from ev.tickets
         where ($1::text is null or cp_id = $1) and ($2::text is null or title ilike '%' || $2 || '%') and ($3 = 'any' or status = $3)
         order by opened desc limit $4`,
        [a.chargePointId ?? null, a.q ?? null, a.status, a.limit],
      ),
    }),
    "tickets.comment": async (a: z.infer<(typeof ARGS)["tickets.comment"]>, ctx) =>
      withScope(d.pool, scope(ctx), async (c) => {
        const t = (await c.query<{ country: string }>("select country from ev.tickets where id = $1", [a.ticketId])).rows[0];
        if (!t) throw forbid(`no ticket ${a.ticketId} that you may see`);
        const r = await c.query<{ id: string }>(
          "insert into ev.ticket_comments (ticket_id, country, author_oid, author_name, via_app, text) values ($1, $2, $3, $4, $5, $6) returning id",
          [a.ticketId, t.country, ctx.viewer.oid, ctx.viewer.name, ctx.appId, a.text],
        );
        return { ticketId: a.ticketId, commentId: `C-${r.rows[0]?.id}` };
      }),
    "docs.search": async (a: z.infer<(typeof ARGS)["docs.search"]>, ctx) => ({
      passages: await q(
        ctx,
        `select source, heading, text, round(ts_rank(tsv, query)::numeric, 3)::float as score
         from ev.docs, websearch_to_tsquery('english', $1) query where tsv @@ query order by score desc limit $2`,
        [a.q, a.limit],
      ),
    }),
    "sessions.revenue": async (a: z.infer<(typeof ARGS)["sessions.revenue"]>, ctx) => ({
      rows: await q(
        ctx,
        `select to_char(month, 'YYYY-MM') as month, site, country, sessions, kwh::float as "kWh", revenue_eur::float as "revenueEur"
         from ev.monthly_sessions where ($1::text is null or country = $1) and ($2::text is null or site = $2)
           and month >= (select max(month) from ev.monthly_sessions) - make_interval(months => $3 - 1)
         order by month, site limit 2000`,
        [a.country ?? null, a.site ?? null, a.months],
      ),
    }),
    "partners.contracts": async (a: z.infer<(typeof ARGS)["partners.contracts"]>, ctx) => ({
      rows: await q(
        ctx,
        `select partner, site, country, start_date as "startDate", end_date as "endDate", revenue_share_pct::float as "revenueSharePct", rent_eur_month::float as "rentEurMonth"
         from ev.partner_contracts where ($1::text is null or partner = $1) and ($2::text is null or site = $2) order by site limit 500`,
        [a.partner ?? null, a.site ?? null],
      ),
    }),
    "teams.post": async (a: z.infer<(typeof ARGS)["teams.post"]>, ctx) => {
      // Simulated: production posts through Microsoft Graph as the viewer (delegated permission).
      await d.pool.query("insert into foundry.outbound (kind, target, body, author_oid, app_id) values ('teams', $1, $2, $3, $4)", [
        a.channel,
        a.text,
        ctx.viewer.oid,
        ctx.appId,
      ]);
      return { messageId: `M-${Date.now().toString(36)}` };
    },
  };

  return {
    /** Runs a connector for a viewer. The caller has already checked the manifest declares it. */
    async call(id: string, args: unknown, ctx: CallContext): Promise<unknown> {
      const def = d.catalog.connectors.find((c) => c.id === id);
      const schema = ARGS[id as ConnectorId];
      if (!def || !schema) throw new HostError("CAPABILITY_NOT_DECLARED", `connector ${id} does not exist`);
      const may = mayUse(def, ctx.viewer);
      if (!may.ok) throw forbid(may.reason);
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success)
        throw new HostError(
          "INVALID_INPUT",
          `${id}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"} ${i.message}`).join("; ")}`,
        );
      return impl[id as ConnectorId](parsed.data as never, ctx);
    },
    /** JSON Schema of a connector's arguments, for model tool use. */
    toolSchema: (id: string) => z.toJSONSchema(ARGS[id as ConnectorId], { io: "input" }),
    def: (id: string) => d.catalog.connectors.find((c) => c.id === id),
  };
};
export type Connectors = ReturnType<typeof createConnectors>;
