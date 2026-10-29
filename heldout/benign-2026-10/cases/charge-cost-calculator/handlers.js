// Charging cost and time calculator: pure computation, no connectors and no model.
// The charging curve is a simple taper: full power up to 50 % state of charge, falling linearly to
// 50 % of peak at 80 %, then to 20 % of peak at 100 %. The session is simulated in 0.1 % steps.

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

function taper(soc) {
  if (soc < 50) return 1;
  if (soc < 80) return 1 - ((soc - 50) / 30) * 0.5;
  return 0.5 - ((soc - 80) / 20) * 0.3;
}

export async function estimate(input, _ctx) {
  const from = input.fromPct;
  const to = input.toPct;
  if (to <= from) {
    return { ok: false, message: "The target charge must be above the start charge." };
  }
  const peak = Math.min(input.chargerKw, input.carPeakKw || input.chargerKw);
  const step = 0.1; // percent of the battery per simulation step
  const kWhPerStep = (input.batteryKwh * step) / 100;

  let minutes = 0;
  let soc = from;
  const curve = [];
  let nextMark = Math.ceil(from / 5) * 5;
  while (soc < to - 1e-9) {
    const kw = peak * taper(soc);
    minutes += (kWhPerStep / kw) * 60;
    soc += step;
    if (soc >= nextMark - 1e-9) {
      curve.push({ socPct: nextMark, kw: round(peak * taper(Math.min(soc, 99.9)), 1), minutes: round(minutes, 1) });
      nextMark += 5;
    }
  }

  const energyKwh = (input.batteryKwh * (to - from)) / 100;
  const costEur = energyKwh * input.priceEurPerKwh + (input.sessionFeeEur || 0);
  return {
    ok: true,
    energyKwh: round(energyKwh, 1),
    costEur: round(costEur, 2),
    minutes: Math.round(minutes),
    averageKw: round(energyKwh / (minutes / 60), 1),
    peakKw: peak,
    curve,
  };
}
