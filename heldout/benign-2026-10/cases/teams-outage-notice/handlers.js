// Outage notice: read status, draft with the fast model, post only through ctx.confirm.

export async function preview(input, ctx) {
  const id = input.id.trim();
  const st = await ctx.connectors.call("chargepoints.status", { id });
  const down = (st.connectors || []).filter((c) => c.status !== "Available" && c.status !== "Charging");
  const facts = [
    `Charge point: ${st.id}`,
    `Overall status: ${st.status}`,
    `Connectors not usable: ${down.map((c) => `${c.id} (${c.status}${c.errorCode ? ", " + c.errorCode : ""})`).join("; ") || "none"}`,
    `Expected back: ${input.expectedBack || "not known yet"}`,
  ].join("\n");
  const r = await ctx.llm.chat({
    model: "fast",
    maxTokens: 300,
    messages: [
      {
        role: "user",
        content: `Write a three-line outage notice for an internal operations Teams channel. Plain text, no greeting. Use only these facts:\n${facts}`,
      },
    ],
  });
  return { id: st.id, status: st.status, connectorsDown: down.length, notice: r.text.trim() };
}

export async function post(input, ctx) {
  return ctx.confirm({
    connector: "teams.post",
    args: { channel: input.channel.trim(), text: input.text.trim() },
    summary: `Post this message to the Teams channel "${input.channel.trim()}" as you:\n\n${input.text.trim()}`,
  });
}
