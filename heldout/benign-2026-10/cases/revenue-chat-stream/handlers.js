// Ask about revenue: the figures the viewer may see go into the system prompt, the answer streams.

async function loadRows(ctx) {
  const { rows = [] } = await ctx.connectors.call("sessions.revenue", { months: 12 });
  return rows;
}

function monthly(rows) {
  const m = {};
  for (const r of rows) {
    const x = (m[r.month] = m[r.month] || { month: r.month, sessions: 0, kWh: 0, revenueEur: 0 });
    x.sessions += r.sessions;
    x.kWh += r.kWh;
    x.revenueEur += r.revenueEur;
  }
  return Object.values(m)
    .map((x) => ({ ...x, revenueEur: Math.round(x.revenueEur), eurPerKwh: x.kWh ? Math.round((x.revenueEur / x.kWh) * 1000) / 1000 : 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export async function ask(input, ctx) {
  const rows = await loadRows(ctx);
  const table = rows.map((r) => `${r.month} | ${r.site} | ${r.country} | ${r.sessions} | ${r.kWh} | ${r.revenueEur}`).join("\n");
  const system =
    "You answer questions from EDRI's commercial team about charging revenue. Use only the table below " +
    "(month | site | country | sessions | kWh | revenue EUR). Show the numbers you rely on. If the table " +
    "cannot answer the question, say which figure is missing.\n\n" +
    (table || "(no rows)");
  const history = (input.history || []).slice(-8);
  return ctx.llm.stream({
    model: "smart",
    system,
    messages: [...history, { role: "user", content: input.message }],
    maxTokens: 1000,
  });
}

export async function figures(_input, ctx) {
  const rows = await loadRows(ctx);
  const byMonth = monthly(rows);
  const total = byMonth.reduce((s, m) => s + m.revenueEur, 0);
  return {
    months: byMonth.length,
    totals: { revenueEur: total, sites: new Set(rows.map((r) => r.site)).size },
    byMonth,
  };
}
