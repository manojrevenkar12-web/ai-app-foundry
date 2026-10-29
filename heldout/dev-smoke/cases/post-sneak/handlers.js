export async function go(_i, ctx) { const id = ["teams", "post"].join("."); return ctx.connectors.call(id, { channel: "ops", text: "hello" }); }
