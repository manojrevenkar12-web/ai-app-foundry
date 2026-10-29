/** Writes the simulated world into the ev schema. The true causes go to a file, not the database. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import type { World } from "./world.js";

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const insert = async (c: pg.ClientBase, table: string, cols: string[], rows: unknown[][]) => {
  for (const part of chunks(rows, 1000)) {
    const params: unknown[] = [];
    const values = part.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(",")})`).join(",");
    await c.query(`insert into ${table} (${cols.join(",")}) values ${values}`, params);
  }
};

/** Runbooks are split into passages by second-level heading. */
export const loadDocs = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const title = /^# (.+)$/m.exec(text)?.[1] ?? f;
      return text
        .split(/^## /m)
        .slice(1)
        .map((part) => {
          const [heading, ...body] = part.split("\n");
          return { source: `runbooks/${f}`, heading: `${title}: ${heading?.trim()}`, text: body.join(" ").replace(/\s+/g, " ").trim() };
        });
    });

export const loadWorld = async (c: pg.ClientBase, w: World, docsDir: string, truthFile: string) => {
  await c.query("begin");
  await c.query("select set_config('foundry.viewer_countries', '*', true)");
  await c.query(
    "truncate ev.ticket_comments, ev.tickets, ev.status_events, ev.chargepoints, ev.monthly_sessions, ev.partner_contracts, ev.docs restart identity cascade",
  );
  await insert(
    c,
    "ev.chargepoints",
    ["id", "site", "city", "country", "lat", "lon", "power_kw", "vendor", "model", "firmware", "status", "last_seen"],
    w.chargepoints.map((p) => [
      p.id,
      p.site,
      p.city,
      p.country,
      p.lat,
      p.lon,
      p.powerKw,
      p.vendor,
      p.model,
      p.firmware,
      p.status,
      p.lastSeen,
    ]),
  );
  await insert(
    c,
    "ev.status_events",
    ["cp_id", "country", "at", "connector", "status", "error_code", "vendor_error_code"],
    w.events.map((e) => [e.cpId, e.country, e.at, e.connector, e.status, e.errorCode, e.vendorErrorCode]),
  );
  await insert(
    c,
    "ev.tickets",
    ["id", "cp_id", "country", "title", "status", "opened", "closed", "technician", "resolution_cause"],
    w.tickets.map((t) => [t.id, t.cpId, t.country, t.title, t.status, t.opened, t.closed, t.technician, t.resolutionCause]),
  );
  await insert(
    c,
    "ev.monthly_sessions",
    ["month", "site", "country", "sessions", "kwh", "revenue_eur"],
    w.months.map((m) => [m.month, m.site, m.country, m.sessions, m.kwh, m.revenueEur]),
  );
  await insert(
    c,
    "ev.partner_contracts",
    ["partner", "site", "country", "start_date", "end_date", "revenue_share_pct", "rent_eur_month"],
    w.contracts.map((k) => [k.partner, k.site, k.country, k.startDate, k.endDate, k.revenueSharePct, k.rentEurMonth]),
  );
  const docs = loadDocs(docsDir);
  await insert(
    c,
    "ev.docs",
    ["source", "heading", "text"],
    docs.map((d) => [d.source, d.heading, d.text]),
  );
  await c.query("commit");
  mkdirSync(join(truthFile, ".."), { recursive: true });
  writeFileSync(truthFile, JSON.stringify(Object.fromEntries(w.tickets.map((t) => [t.id, t.trueCause]))));
  return {
    chargepoints: w.chargepoints.length,
    events: w.events.length,
    tickets: w.tickets.length,
    months: w.months.length,
    contracts: w.contracts.length,
    docs: docs.length,
  };
};
