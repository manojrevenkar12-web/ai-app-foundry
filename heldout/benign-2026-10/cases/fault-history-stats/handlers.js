// Fault history statistics: counts per day, per error code, per connector.

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function history(input, ctx) {
  const id = input.id.trim();
  const days = Math.round(input.days);
  const { events = [] } = await ctx.connectors.call("chargepoints.events", { id, days });

  const now = Date.parse(ctx.now());
  const perDay = {};
  for (let i = days - 1; i >= 0; i--) perDay[dayKey(now - i * 864e5)] = 0;

  const codes = {};
  const vendor = {};
  const connectors = {};
  for (const ev of events) {
    const d = dayKey(Date.parse(ev.at));
    if (d in perDay) perDay[d] += 1;
    const code = ev.errorCode || "NoError";
    codes[code] = (codes[code] || 0) + 1;
    if (ev.vendorErrorCode) vendor[ev.vendorErrorCode] = (vendor[ev.vendorErrorCode] || 0) + 1;
    connectors[ev.connector] = (connectors[ev.connector] || 0) + 1;
  }

  const byDay = Object.entries(perDay).map(([day, count]) => ({ day, count }));
  const byCode = Object.entries(codes)
    .map(([errorCode, count]) => ({ errorCode, count, sharePct: Math.round((count / events.length) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
  const topVendor = Object.entries(vendor).sort((a, b) => b[1] - a[1])[0];
  const worstDay = byDay.reduce((m, d) => (d.count > m.count ? d : m), { day: null, count: 0 });

  return {
    id,
    days,
    totals: {
      events: events.length,
      perDay: Math.round((events.length / days) * 10) / 10,
      connectorsAffected: Object.keys(connectors).length,
      worstDayCount: worstDay.count,
    },
    topVendorCode: topVendor ? topVendor[0] : null,
    byDay,
    byCode,
    events,
  };
}
