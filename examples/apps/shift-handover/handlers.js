export async function tidy(input, ctx) {
  const r = await ctx.llm.chat({
    model: "fast",
    maxTokens: 600,
    messages: [
      {
        role: "user",
        content: `Rewrite these shift notes as a short checklist for the next shift. Keep charge point ids exactly.\n\n${input.notes}`,
      },
    ],
  });
  const key = ctx.now();
  await ctx.store.put("handovers", key, { at: key, checklist: r.text });
  return { checklist: r.text, saved: key };
}

export async function recent(_input, ctx) {
  const items = await ctx.store.list("handovers", { limit: 10 });
  return { rows: items.map((i) => i.value).reverse() };
}
