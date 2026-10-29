// Spare parts board: a shared collection the whole Ops audience sees. Requests carry the name of
// the person who made them, taken from ctx.user.

function keyFor(chargePointId, part) {
  return `${chargePointId}-${part}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function request(input, ctx) {
  const key = keyFor(input.chargePointId.trim(), input.part.trim());
  const item = {
    key,
    chargePointId: input.chargePointId.trim(),
    part: input.part.trim(),
    quantity: Math.round(input.quantity),
    urgency: input.urgency,
    status: "open",
    requestedBy: ctx.user.name,
    requestedAt: ctx.now(),
  };
  await ctx.store.put("parts", key, item);
  return { key, item };
}

export async function board(_input, ctx) {
  const items = await ctx.store.list("parts", { limit: 200 });
  const rows = items
    .map((i) => i.value)
    .filter((v) => v.status === "open")
    .sort((a, b) => (a.urgency === b.urgency ? (a.requestedAt < b.requestedAt ? -1 : 1) : a.urgency === "high" ? -1 : 1));
  return {
    rows,
    stats: { open: rows.length, high: rows.filter((r) => r.urgency === "high").length, units: rows.reduce((s, r) => s + r.quantity, 0) },
  };
}

export async function delivered(input, ctx) {
  const item = await ctx.store.get("parts", input.key);
  if (!item) return { key: input.key, found: false, message: "No request with that key on the board." };
  const updated = { ...item, status: "delivered", deliveredBy: ctx.user.name, deliveredAt: ctx.now() };
  await ctx.store.put("parts", input.key, updated);
  return { key: input.key, found: true, item: updated };
}
