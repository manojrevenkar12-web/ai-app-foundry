// Ticket backlog trend: one tickets.search, counting and ageing in code.

const DAY = 864e5;

export async function backlog(input, ctx) {
  const days = Math.round(input.days);
  const args = { status: "any" };
  if (input.q && input.q.trim()) args.q = input.q.trim();
  const { rows = [] } = await ctx.connectors.call("tickets.search", args);

  const now = Date.parse(ctx.now());
  const start = now - days * DAY;
  const perDay = {};
  for (let t = start + DAY; t <= now; t += DAY) perDay[new Date(t).toISOString().slice(0, 10)] = { opened: 0 };

  const tech = {};
  let open = 0;
  let oldest = null;
  for (const r of rows) {
    const opened = Date.parse(r.opened);
    const valid = Number.isFinite(opened);
    const d = valid ? new Date(opened).toISOString().slice(0, 10) : null;
    if (d && perDay[d]) perDay[d].opened += 1;
    if (r.status === "open") {
      open += 1;
      const age = valid ? Math.floor((now - opened) / DAY) : 0;
      if (!oldest || age > oldest.ageDays) oldest = { id: r.id, chargePointId: r.chargePointId, title: r.title, ageDays: age };
      const name = r.technician || "unassigned";
      tech[name] = (tech[name] || 0) + 1;
    }
  }

  return {
    days,
    q: args.q || null,
    stats: { tickets: rows.length, open, closed: rows.length - open, oldestOpenDays: oldest ? oldest.ageDays : 0 },
    oldest,
    byDay: Object.entries(perDay).map(([day, v]) => ({ day, opened: v.opened })),
    byTechnician: Object.entries(tech)
      .map(([technician, openTickets]) => ({ technician, openTickets }))
      .sort((a, b) => b.openTickets - a.openTickets),
  };
}
