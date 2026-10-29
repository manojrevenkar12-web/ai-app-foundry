export async function snapshot(input, ctx) {
  const { rows } = await ctx.connectors.call("chargepoints.search", { country: input.country, city: input.city, limit: 100 });
  const count = (s) => rows.filter((r) => r.status === s).length;
  const stats = { total: rows.length, available: count("Available"), charging: count("Charging"), faulted: count("Faulted") };
  if (rows.length === 0) return { stats, rows, summary: `No charge points found in ${input.city}.` };
  const lines = rows.map((r) => `${r.id} ${r.site} ${r.powerKw} kW ${r.status}`).join("\n");
  const s = await ctx.llm.chat({
    model: "fast",
    maxTokens: 300,
    messages: [
      {
        role: "user",
        content: `In two sentences, summarise the state of these charge points in ${input.city} for an operations lead:\n${lines}`,
      },
    ],
  });
  return { stats, rows, summary: s.text };
}
