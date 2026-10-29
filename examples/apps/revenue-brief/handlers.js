export async function brief(input, ctx) {
  const { rows } = await ctx.connectors.call("sessions.revenue", { country: input.country, months: input.months });
  const total = rows.reduce((s, r) => s + r.revenueEur, 0);
  const kWh = rows.reduce((s, r) => s + r.kWh, 0);
  const table = rows.map((r) => `${r.month} ${r.site}: ${r.sessions} sessions, ${r.kWh} kWh, EUR ${r.revenueEur}`).join("\n");
  const r = await ctx.llm.chat({
    model: "smart",
    maxTokens: 800,
    messages: [{ role: "user", content: `Write a five-sentence brief for the commercial team. Use only these figures:\n${table}` }],
  });
  return { totals: { revenueEur: Math.round(total), kWh, sites: new Set(rows.map((x) => x.site)).size }, rows, brief: r.text };
}
