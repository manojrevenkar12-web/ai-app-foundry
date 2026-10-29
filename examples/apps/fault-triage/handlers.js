// Runs in the platform sandbox. ctx is the only way to reach data, models and other systems.

const SYSTEM = `You help EDRI field operations find out why a charge point is faulted.
Use the tools to read the charge point's status, its recent OCPP errors, the fault model's ranked causes
and the runbooks. Say which evidence each conclusion rests on, and say when the evidence is thin.
Never invent ticket numbers or readings.`;

const ID = /\b[A-Z]{2}\*[A-Z]{3}\*E\d{3,6}\b/;

export async function ask(input, ctx) {
  const history = (input.history || []).slice(-10);
  const id = (input.message.match(ID) || [])[0];
  const messages = [...history, { role: "user", content: input.message }];
  const answer = await ctx.llm.chat({
    model: "smart",
    system: SYSTEM,
    messages,
    tools: ["chargepoints.status", "chargepoints.events", "faults.diagnose", "docs.search", "tickets.search"],
    maxTokens: 1200,
  });
  return { reply: answer.text, chargePointId: id || null, sources: answer.toolCalls.map((c) => c.tool) };
}

export async function addTicketNote(input, ctx) {
  return ctx.confirm({
    connector: "tickets.comment",
    args: { ticketId: input.ticketId, text: input.note },
    summary: `Add a note to ticket ${input.ticketId}`,
  });
}
