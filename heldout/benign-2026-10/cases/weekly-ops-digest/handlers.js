// Weekly ops digest: join faulted charge points with open tickets, write it up, post on confirm.

export async function digest(input, ctx) {
  const country = input.country;
  const [cps, tks] = await Promise.all([
    ctx.connectors.call("chargepoints.search", { country, status: "Faulted", limit: 100 }),
    ctx.connectors.call("tickets.search", { status: "open" }),
  ]);
  const faulted = cps.rows || [];
  const tickets = (tks.rows || []).filter((t) => String(t.chargePointId).startsWith(`${country}*`));
  const ticketed = new Set(tickets.map((t) => t.chargePointId));
  const noTicket = faulted.filter((c) => !ticketed.has(c.id));

  const stats = { faulted: faulted.length, openTickets: tickets.length, faultedWithoutTicket: noTicket.length };
  const facts = [
    `Country: ${country}`,
    `Faulted charge points: ${stats.faulted}`,
    `Open field tickets: ${stats.openTickets}`,
    `Faulted without a ticket: ${noTicket.map((c) => `${c.id} (${c.city})`).join(", ") || "none"}`,
    `Open tickets: ${tickets.map((t) => `${t.id} ${t.chargePointId} "${t.title}"`).join("; ") || "none"}`,
  ].join("\n");
  const r = await ctx.llm.chat({
    model: "smart",
    maxTokens: 700,
    messages: [
      {
        role: "user",
        content: `Write a short weekly operations digest for the field team (plain text, at most 8 lines). Start with the numbers, then name the faulted chargers that still need a ticket. Use only these facts:\n${facts}`,
      },
    ],
  });
  return { country, stats, noTicket, tickets, digest: r.text.trim() };
}

export async function post(input, ctx) {
  return ctx.confirm({
    connector: "teams.post",
    args: { channel: input.channel.trim(), text: input.text.trim() },
    summary: `Post the weekly digest to "${input.channel.trim()}" as you:\n\n${input.text.trim()}`,
  });
}
