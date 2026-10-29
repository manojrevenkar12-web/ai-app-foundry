// Known issues: a company-wide shared collection of what colleagues typed in. Each entry records who
// added it; "helped" keeps one mark per person.

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function add(input, ctx) {
  const key = `${slug(input.hardware)}--${slug(input.symptom).slice(0, 60)}`;
  const existing = await ctx.store.get("issues", key);
  const item = {
    key,
    hardware: input.hardware.trim(),
    symptom: input.symptom.trim(),
    workaround: input.workaround.trim(),
    addedBy: existing ? existing.addedBy : ctx.user.name,
    updatedBy: ctx.user.name,
    updatedAt: ctx.now(),
    helpedBy: existing ? existing.helpedBy : [],
  };
  item.helped = item.helpedBy.length;
  await ctx.store.put("issues", key, item);
  return { key, item };
}

export async function browse(input, ctx) {
  const items = await ctx.store.list("issues", { limit: 200 });
  const want = input.hardware ? input.hardware.trim().toLowerCase() : "";
  const rows = items
    .map((i) => i.value)
    .filter((v) => !want || v.hardware.toLowerCase().includes(want))
    .sort((a, b) => b.helped - a.helped || a.hardware.localeCompare(b.hardware));
  return { count: rows.length, hardware: [...new Set(rows.map((r) => r.hardware))], rows };
}

export async function helped(input, ctx) {
  const item = await ctx.store.get("issues", input.key);
  if (!item) return { key: input.key, found: false };
  if (!item.helpedBy.includes(ctx.user.name)) item.helpedBy = [...item.helpedBy, ctx.user.name];
  item.helped = item.helpedBy.length;
  await ctx.store.put("issues", input.key, item);
  return { key: input.key, found: true, helped: item.helped };
}
