// Partner payout review: confidential revenue joined with confidential contracts, for the
// commercial team only (audience EDRI-Commercial). Nothing is stored.

const round2 = (x) => Math.round(x * 100) / 100;

export async function review(input, ctx) {
  const months = Math.round(input.months);
  let revenue;
  let contracts;
  try {
    revenue = await ctx.connectors.call("sessions.revenue", { country: input.country, months });
    contracts = await ctx.connectors.call("partners.contracts", {});
  } catch (e) {
    if (e.code === "FORBIDDEN_FOR_VIEWER") {
      return {
        country: input.country,
        months,
        totals: { revenueEur: 0, partnerPayoutEur: 0, netEur: 0, sites: 0 },
        sites: [],
        note: "Revenue and contracts are only available to the commercial team for the countries they cover.",
      };
    }
    throw e;
  }

  const bySite = {};
  for (const r of revenue.rows || []) {
    const s = (bySite[r.site] = bySite[r.site] || { site: r.site, country: r.country, sessions: 0, kWh: 0, revenueEur: 0, months: 0 });
    s.sessions += r.sessions;
    s.kWh += r.kWh;
    s.revenueEur += r.revenueEur;
    s.months += 1;
  }
  const contractBySite = {};
  for (const c of contracts.rows || []) contractBySite[c.site] = c;

  const sites = Object.values(bySite).map((s) => {
    const c = contractBySite[s.site];
    const sharePct = c ? c.revenueSharePct : 0;
    const rent = c ? c.rentEurMonth * s.months : 0;
    const payout = round2((s.revenueEur * sharePct) / 100 + rent);
    return {
      site: s.site,
      partner: c ? c.partner : "no contract found",
      sessions: s.sessions,
      kWh: s.kWh,
      revenueEur: round2(s.revenueEur),
      revenueSharePct: sharePct,
      rentEur: round2(rent),
      partnerPayoutEur: payout,
      netEur: round2(s.revenueEur - payout),
      contractEnds: c ? c.endDate : null,
    };
  });
  sites.sort((a, b) => b.revenueEur - a.revenueEur);

  const totals = {
    revenueEur: round2(sites.reduce((t, s) => t + s.revenueEur, 0)),
    partnerPayoutEur: round2(sites.reduce((t, s) => t + s.partnerPayoutEur, 0)),
    netEur: round2(sites.reduce((t, s) => t + s.netEur, 0)),
    sites: sites.length,
  };

  let note = `No revenue rows for ${input.country} in the last ${months} months.`;
  if (sites.length > 0) {
    const lines = sites
      .map((s) => `${s.site}: revenue EUR ${s.revenueEur}, partner ${s.partner} gets ${s.revenueSharePct}% plus rent EUR ${s.rentEur}, net EUR ${s.netEur}`)
      .join("\n");
    const r = await ctx.llm.chat({
      model: "smart",
      maxTokens: 600,
      messages: [
        {
          role: "user",
          content: `In four sentences, tell the commercial team which sites carry the highest partner cost relative to revenue. Use only these figures:\n${lines}`,
        },
      ],
    });
    note = r.text.trim();
  }
  return { country: input.country, months, totals, sites, note };
}
