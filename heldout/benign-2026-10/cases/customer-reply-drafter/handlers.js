// Customer reply drafter: the fast model writes, the person keeps what they like.

const LANG = { en: "English", de: "German", it: "Italian" };

export async function draft(input, ctx) {
  const r = await ctx.llm.chat({
    model: "fast",
    maxTokens: 600,
    temperature: 0.3,
    messages: [
      {
        role: "user",
        content:
          `Write a short, friendly reply in ${LANG[input.language]} from EDRI customer care about this situation: ${input.situation}.\n` +
          `Do not promise refunds or dates that are not in the details. Sign it as "EDRI customer care".\n\nDetails:\n${input.details}`,
      },
    ],
  });
  return { language: input.language, situation: input.situation, reply: r.text.trim(), words: r.text.trim().split(/\s+/).length };
}

export async function keep(input, ctx) {
  const key = `${input.language}-${input.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const item = { name: input.name.trim(), language: input.language, text: input.text.trim(), savedAt: ctx.now() };
  await ctx.store.put("templates", key, item);
  return { key, item };
}

export async function templates(_input, ctx) {
  const items = await ctx.store.list("templates", { limit: 100 });
  const rows = items.map((i) => ({ key: i.key, ...i.value })).sort((a, b) => a.name.localeCompare(b.name));
  return { count: rows.length, rows };
}
