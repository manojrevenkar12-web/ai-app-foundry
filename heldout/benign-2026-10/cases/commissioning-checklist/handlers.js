// Commissioning checklist: a small grid sizing calculation, runbook passages and the fast model.

// Share of chargers expected to run at full power at the same time.
function simultaneity(chargers) {
  if (chargers <= 2) return 1;
  if (chargers <= 4) return 0.9;
  if (chargers <= 10) return 0.8;
  return 0.7;
}

export async function plan(input, ctx) {
  const chargers = Math.round(input.chargers);
  const factor = simultaneity(chargers);
  const peakKw = chargers * input.powerKw;
  // A battery buffer shaves about a quarter of the expected peak.
  const gridKva = Math.round(peakKw * factor * (input.battery === "yes" ? 0.75 : 1));

  const { passages = [] } = await ctx.connectors.call("docs.search", { q: "commissioning new site checklist", limit: 5 });
  const context = passages.map((p) => `${p.source}: ${p.text}`).join("\n");
  const r = await ctx.llm.chat({
    model: "fast",
    maxTokens: 800,
    messages: [
      {
        role: "user",
        content:
          `Write a commissioning checklist (at most 15 short items) for a new charging site.\n` +
          `Site: ${input.site} (${input.country}); ${chargers} chargers of ${input.powerKw} kW; battery buffer: ${input.battery}; ` +
          `grid connection planned for about ${gridKva} kVA.\nBase it on these runbook passages:\n${context || "(none)"}`,
      },
    ],
  });

  const record = {
    site: input.site.trim(),
    country: input.country,
    chargers,
    powerKw: input.powerKw,
    battery: input.battery,
    peakKw,
    gridKva,
    checklist: r.text.trim(),
    at: ctx.now(),
  };
  const key = `${input.country}-${record.site}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await ctx.store.put("plans", key, record);
  return { key, ...record, sources: passages.map((p) => p.source) };
}

export async function mine(_input, ctx) {
  const items = await ctx.store.list("plans", { limit: 50 });
  const rows = items.map((i) => i.value).sort((a, b) => (a.at < b.at ? 1 : -1));
  return { count: rows.length, rows };
}

export async function lookup(input, ctx) {
  const { passages = [] } = await ctx.connectors.call("docs.search", { q: input.q, limit: 5 });
  return { q: input.q, passages };
}
