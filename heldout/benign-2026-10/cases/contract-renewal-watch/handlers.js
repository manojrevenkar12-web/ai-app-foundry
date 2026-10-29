// Contract renewal watch. Contract terms are confidential, so the follow-up notes that copy a
// contract's end date and partner go into a private collection classified confidential.

function monthsBetween(fromMs, toMs) {
  return Math.round(((toMs - fromMs) / (864e5 * 30.44)) * 10) / 10;
}

export async function upcoming(input, ctx) {
  const now = Date.parse(ctx.now());
  const { rows = [] } = await ctx.connectors.call("partners.contracts", {});
  const within = rows
    .map((c) => ({ ...c, monthsLeft: monthsBetween(now, Date.parse(c.endDate)) }))
    .filter((c) => c.monthsLeft >= 0 && c.monthsLeft <= input.withinMonths)
    .sort((a, b) => a.monthsLeft - b.monthsLeft);
  return {
    withinMonths: input.withinMonths,
    stats: { ending: within.length, contracts: rows.length },
    rows: within,
  };
}

export async function followUp(input, ctx) {
  const site = input.site.trim();
  let contract = null;
  try {
    const { rows = [] } = await ctx.connectors.call("partners.contracts", { site });
    contract = rows[0] || null;
  } catch (e) {
    ctx.log("contract lookup failed", e.code);
  }
  const item = {
    site,
    partner: contract ? contract.partner : null,
    endDate: contract ? contract.endDate : null,
    nextStep: input.nextStep,
    note: input.note.trim(),
    updatedAt: ctx.now(),
  };
  const key = site.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await ctx.store.put("followups", key, item);
  return { saved: key, item };
}

export async function myFollowUps(_input, ctx) {
  const items = await ctx.store.list("followups", { limit: 100 });
  const rows = items.map((i) => i.value).sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)));
  return { count: rows.length, rows };
}
