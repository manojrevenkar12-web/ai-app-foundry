// Power mix by country: one search (up to 100 charge points), statistics in code.

const CLASSES = [
  { name: "AC up to 22 kW", max: 22 },
  { name: "DC up to 60 kW", max: 60 },
  { name: "DC up to 150 kW", max: 150 },
  { name: "DC up to 300 kW", max: 300 },
  { name: "DC above 300 kW", max: Infinity },
];

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function mix(input, ctx) {
  let rows = [];
  try {
    rows = (await ctx.connectors.call("chargepoints.search", { country: input.country, limit: 100 })).rows || [];
  } catch (e) {
    if (e.code !== "FORBIDDEN_FOR_VIEWER") throw e;
  }
  const buckets = CLASSES.map((c) => ({ powerClass: c.name, total: 0, available: 0, faulted: 0 }));
  for (const r of rows) {
    const i = CLASSES.findIndex((c) => r.powerKw <= c.max);
    const b = buckets[i];
    b.total += 1;
    if (r.status === "Available") b.available += 1;
    if (r.status === "Faulted") b.faulted += 1;
  }
  for (const b of buckets) b.availablePct = b.total ? Math.round((b.available / b.total) * 1000) / 10 : 0;

  const kw = rows.map((r) => r.powerKw);
  const dc = rows.filter((r) => r.powerKw > 22).length;
  return {
    country: input.country,
    sample: rows.length,
    stats: {
      meanKw: kw.length ? Math.round((kw.reduce((s, x) => s + x, 0) / kw.length) * 10) / 10 : 0,
      medianKw: median(kw),
      dcSharePct: rows.length ? Math.round((dc / rows.length) * 1000) / 10 : 0,
      installedKw: kw.reduce((s, x) => s + x, 0),
    },
    buckets,
    note: rows.length === 100 ? "Based on the first 100 charge points the search returned." : `Based on all ${rows.length} charge points found.`,
  };
}
