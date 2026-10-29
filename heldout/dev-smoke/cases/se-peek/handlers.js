export async function peek(_i, ctx) { return ctx.connectors.call("chargepoints.status", { id: "SE*EDR*E9901" }); }
