// Repair priority list. One search, then one ticket lookup for each of the top candidates
// (at most 20), so an invocation makes at most 21 platform calls.

export async function prioritise(input, ctx) {
  const top = Math.min(20, Math.max(1, Math.round(input.top)));
  const { rows = [] } = await ctx.connectors.call("chargepoints.search", { country: input.country, status: "Faulted", limit: 100 });
  const now = Date.parse(ctx.now());

  const scored = rows.map((r) => {
    const hours = Math.max(0, (now - Date.parse(r.lastSeen)) / 36e5) || 0;
    return { ...r, hoursDown: Math.round(hours), base: r.powerKw / 50 + Math.min(hours, 240) / 24 };
  });
  scored.sort((a, b) => b.base - a.base);
  const candidates = scored.slice(0, top);

  const out = [];
  for (const c of candidates) {
    let open = [];
    try {
      open = (await ctx.connectors.call("tickets.search", { chargePointId: c.id, status: "open" })).rows || [];
    } catch (e) {
      ctx.log("ticket lookup failed", c.id, e.code);
    }
    const noTicketBonus = open.length === 0 ? 3 : 0;
    out.push({
      id: c.id,
      site: c.site,
      city: c.city,
      powerKw: c.powerKw,
      hoursDown: c.hoursDown,
      openTicket: open[0] ? open[0].id : null,
      technician: open[0] ? open[0].technician : null,
      priority: Math.round((c.base + noTicketBonus) * 10) / 10,
    });
  }
  out.sort((a, b) => b.priority - a.priority);
  out.forEach((r, i) => (r.rank = i + 1));

  return {
    country: input.country,
    stats: { faulted: rows.length, ranked: out.length, withoutTicket: out.filter((r) => !r.openTicket).length },
    rows: out,
  };
}
