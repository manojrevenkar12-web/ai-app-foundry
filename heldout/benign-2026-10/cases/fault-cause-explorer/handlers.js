// Fault cause explorer: no model of our own, only the data science team's fault model.

export async function diagnose(input, ctx) {
  const id = input.id.trim();
  const [dx, st] = await Promise.all([
    ctx.connectors.call("faults.diagnose", { id }),
    ctx.connectors.call("chargepoints.status", { id }),
  ]);
  const causes = (dx.causes || [])
    .map((c) => ({ cause: c.cause, label: c.cause.replace(/_/g, " "), probabilityPct: Math.round(c.probability * 1000) / 10 }))
    .sort((a, b) => b.probabilityPct - a.probabilityPct);
  const top = causes[0] || null;
  const confidence = !top ? "none" : top.probabilityPct >= 60 ? "clear" : top.probabilityPct >= 35 ? "likely" : "unclear";
  return {
    id,
    status: st.status,
    connectors: st.connectors || [],
    modelVersion: dx.modelVersion,
    topCause: top ? top.cause : null,
    confidence,
    causes,
    evidence: (dx.evidence || []).map((e) => ({ evidence: e })),
  };
}

export async function runbook(input, ctx) {
  const cause = input.cause.trim();
  const { passages = [] } = await ctx.connectors.call("docs.search", { q: cause.replace(/_/g, " "), limit: 5 });
  return { cause, count: passages.length, passages };
}
