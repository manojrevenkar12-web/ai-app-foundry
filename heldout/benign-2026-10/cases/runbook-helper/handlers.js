// Runbook helper: retrieval over docs.search, answer with the smart model.

const SYSTEM = `You answer questions from EDRI colleagues about charge point hardware and procedures.
Use the runbook passages below and, if a charge point id is named, its current status from the tool.
Name the runbook each step comes from. If the runbooks do not cover the question, say so plainly.`;

export async function ask(input, ctx) {
  let passages = [];
  try {
    const found = await ctx.connectors.call("docs.search", { q: input.message, limit: 5 });
    passages = found.passages || [];
  } catch (e) {
    ctx.log("docs.search failed", e.code);
  }
  const context = passages.map((p, i) => `[${i + 1}] ${p.source} - ${p.heading}\n${p.text}`).join("\n\n");
  const history = (input.history || []).slice(-8);
  const answer = await ctx.llm.chat({
    model: "smart",
    system: `${SYSTEM}\n\nRunbook passages:\n${context || "(none found)"}`,
    messages: [...history, { role: "user", content: input.message }],
    tools: ["chargepoints.status"],
    maxTokens: 900,
  });
  const sources = [...new Set(passages.map((p) => p.source))];
  return { reply: answer.text, sources };
}
