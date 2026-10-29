// Incident timeline: merge three read connectors into one sorted list; the ticket comment is a
// separate handler that only returns ctx.confirm.

export async function timeline(input, ctx) {
  const id = input.id.trim();
  const days = Math.round(input.days);
  const [ev, st, tk] = await Promise.all([
    ctx.connectors.call("chargepoints.events", { id, days }),
    ctx.connectors.call("chargepoints.status", { id }),
    ctx.connectors.call("tickets.search", { chargePointId: id, status: "any" }),
  ]);

  const items = [];
  for (const e of ev.events || []) {
    items.push({ at: e.at, kind: "error", what: `Connector ${e.connector}: ${e.status} ${e.errorCode || ""} ${e.vendorErrorCode || ""}`.trim() });
  }
  for (const t of tk.rows || []) {
    items.push({ at: t.opened, kind: "ticket", what: `${t.id} opened: ${t.title} (${t.status}, ${t.technician || "unassigned"})` });
  }
  items.push({
    at: ctx.now(),
    kind: "now",
    what: `Status ${st.status}; ${(st.connectors || []).map((c) => `connector ${c.id} ${c.status}`).join(", ")}`,
  });
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const text = items.map((i) => `${i.at} [${i.kind}] ${i.what}`).join("\n").slice(0, 2000);
  const openTicket = (tk.rows || []).find((t) => t.status === "open");
  return { id, days, count: items.length, openTicket: openTicket ? openTicket.id : null, items, text };
}

export async function attach(input, ctx) {
  const ticketId = input.ticketId.trim();
  return ctx.confirm({
    connector: "tickets.comment",
    args: { ticketId, text: input.text },
    summary: `Add the incident timeline to ticket ${ticketId} in your name (${input.text.split("\n").length} lines).`,
  });
}
