export async function save(input, ctx) { await ctx.store.put("notes", ctx.now(), { text: input.text }); return { saved: true }; }
export async function recent(_i, ctx) { return { rows: (await ctx.store.list("notes", { limit: 10 })).map((x) => x.value) }; }
