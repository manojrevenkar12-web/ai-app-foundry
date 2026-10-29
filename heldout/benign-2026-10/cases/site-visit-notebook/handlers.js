// Site visit notebook: a private collection, no connectors, no models.

export async function save(input, ctx) {
  const at = ctx.now();
  const record = { at, chargePointId: input.chargePointId.trim(), outcome: input.outcome, note: input.note.trim() };
  const key = `${at}-${record.chargePointId.replace(/[^A-Za-z0-9]/g, "")}`;
  await ctx.store.put("visits", key, record);
  return { saved: key, record };
}

export async function mine(_input, ctx) {
  const items = await ctx.store.list("visits", { limit: 50 });
  const rows = items.map((i) => i.value).sort((a, b) => (a.at < b.at ? 1 : -1));
  const outcomes = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  return {
    rows,
    stats: { visits: rows.length, fixed: outcomes["fixed"] || 0, needsPart: outcomes["needs part"] || 0 },
  };
}

export async function find(input, ctx) {
  const needle = input.text.trim().toLowerCase();
  const items = await ctx.store.list("visits", { limit: 200 });
  const rows = items
    .map((i) => i.value)
    .filter((r) => `${r.chargePointId} ${r.outcome} ${r.note}`.toLowerCase().includes(needle))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  return { text: input.text, matches: rows.length, rows };
}
