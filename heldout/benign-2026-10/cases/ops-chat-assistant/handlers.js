// Ops chat assistant: the model uses read connectors as tools, run by the platform as the viewer.

const SYSTEM = `You are an operations assistant for EDRI's field teams.
Use the tools to look up charge points, their status, their recent OCPP errors and open tickets.
Answer briefly, with charge point ids and ticket ids exactly as the tools return them.
If a tool returns nothing or refuses, say that you could not see that data; do not guess.`;

export async function ask(input, ctx) {
  const history = (input.history || []).slice(-10);
  const answer = await ctx.llm.chat({
    model: "smart",
    system: `${SYSTEM}\nThe person asking is ${ctx.user.name}. Today is ${ctx.now().slice(0, 10)}.`,
    messages: [...history, { role: "user", content: input.message }],
    tools: ["chargepoints.search", "chargepoints.status", "chargepoints.events", "tickets.search"],
    maxTokens: 1000,
  });
  const used = answer.toolCalls.filter((c) => c.ok).map((c) => c.tool);
  return { reply: answer.text, sources: [...new Set(used)], toolCalls: answer.toolCalls.length };
}
