// Runbook answers, live: retrieve, then stream the fast model's answer.

export async function ask(input, ctx) {
  const { passages = [] } = await ctx.connectors.call("docs.search", { q: input.message, limit: 6 });
  const context = passages.map((p) => `Source: ${p.source} (${p.heading})\n${p.text}`).join("\n---\n");
  return ctx.llm.stream({
    model: "fast",
    system:
      "Answer the colleague's question in numbered steps, using only the runbook passages below. " +
      "End with the list of sources you used. If the passages do not answer it, say so.\n\n" +
      (context || "(no passages found)"),
    messages: [...(input.history || []).slice(-6), { role: "user", content: input.message }],
    maxTokens: 700,
  });
}

export async function passages(input, ctx) {
  const limit = Math.round(input.limit || 5);
  const res = await ctx.connectors.call("docs.search", { q: input.q, limit });
  const rows = (res.passages || []).map((p) => ({ ...p, score: Math.round(p.score * 100) / 100 }));
  return { q: input.q, count: rows.length, passages: rows };
}
