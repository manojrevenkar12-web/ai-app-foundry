// Faulted right now: one connector call, counting done in code.

export async function board(input, ctx) {
  let rows = [];
  try {
    const res = await ctx.connectors.call("chargepoints.search", { country: input.country, status: "Faulted", limit: 100 });
    rows = res.rows || [];
  } catch (e) {
    if (e.code === "FORBIDDEN_FOR_VIEWER") {
      return {
        country: input.country,
        stats: { faulted: 0, highPower: 0, cities: 0 },
        byCity: [],
        rows: [],
        note: `You cannot see charge points in ${input.country}. Pick a country your team covers.`,
      };
    }
    throw e;
  }

  const now = Date.parse(ctx.now());
  const enriched = rows.map((r) => {
    const seen = Date.parse(r.lastSeen);
    const hours = Number.isFinite(seen) ? Math.max(0, Math.round((now - seen) / 36e5)) : null;
    return { ...r, hoursSinceSeen: hours };
  });
  enriched.sort((a, b) => (b.hoursSinceSeen || 0) - (a.hoursSinceSeen || 0));

  const counts = {};
  for (const r of enriched) counts[r.city] = (counts[r.city] || 0) + 1;
  const byCity = Object.entries(counts)
    .map(([city, faulted]) => ({ city, faulted }))
    .sort((a, b) => b.faulted - a.faulted || a.city.localeCompare(b.city));

  const stats = {
    faulted: enriched.length,
    highPower: enriched.filter((r) => r.powerKw >= 150).length,
    cities: byCity.length,
  };
  const note =
    enriched.length === 0
      ? `No faulted charge points in ${input.country} right now.`
      : `${stats.faulted} faulted charge points in ${stats.cities} cities; ${stats.highPower} of them are 150 kW or more.`;
  return { country: input.country, stats, byCity, rows: enriched, note };
}
