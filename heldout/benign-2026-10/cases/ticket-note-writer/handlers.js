// Ticket note writer: read tickets, draft with the fast model, write only via ctx.confirm.

export async function find(input, ctx) {
  const { rows = [] } = await ctx.connectors.call("tickets.search", { chargePointId: input.chargePointId.trim(), status: "open" });
  return { chargePointId: input.chargePointId.trim(), count: rows.length, rows };
}

export async function draft(input, ctx) {
  const r = await ctx.llm.chat({
    model: "fast",
    maxTokens: 500,
    messages: [
      {
        role: "user",
        content:
          "Rewrite these technician bullet points as a short, factual field service ticket note (at most 6 sentences). " +
          "Keep charge point ids, part names and readings exactly as written. Do not add anything that is not in the bullets.\n\n" +
          input.bullets,
      },
    ],
  });
  const note = r.text.trim().slice(0, 2000);
  return { ticketId: input.ticketId.trim(), note, characters: note.length };
}

export async function post(input, ctx) {
  const ticketId = input.ticketId.trim();
  const text = input.text.trim();
  return ctx.confirm({
    connector: "tickets.comment",
    args: { ticketId, text },
    summary: `Add this note to ticket ${ticketId} in your name:\n\n${text}`,
  });
}
