/**
 * A simulated charge point network shaped like EDRI's: about 9,000 public charge points in 11
 * countries, OCPP 1.6 status notifications, field service tickets, monthly sessions and revenue,
 * location partner contracts and runbooks. Faults have root causes with overlapping error
 * signatures; closed tickets record a resolution cause, wrong about one time in twelve, as people
 * record them. Those labels are what the fault model learns from.
 */
import { type Rng, rng } from "./rng.js";

export const COUNTRIES: Record<string, { cities: Array<[string, number, number]>; share: number; code: string }> = {
  DE: {
    code: "DE",
    share: 0.34,
    cities: [
      ["Essen", 51.4556, 7.0116],
      ["Dortmund", 51.5136, 7.4653],
      ["Düsseldorf", 51.2277, 6.7735],
      ["Köln", 50.9375, 6.9603],
      ["Berlin", 52.52, 13.405],
      ["Hamburg", 53.5511, 9.9937],
      ["München", 48.1351, 11.582],
      ["Frankfurt", 50.1109, 8.6821],
      ["Stuttgart", 48.7758, 9.1829],
      ["Leipzig", 51.3397, 12.3731],
    ],
  },
  NL: {
    code: "NL",
    share: 0.1,
    cities: [
      ["Amsterdam", 52.3676, 4.9041],
      ["Rotterdam", 51.9244, 4.4777],
      ["Utrecht", 52.0907, 5.1214],
      ["Eindhoven", 51.4416, 5.4697],
    ],
  },
  GB: {
    code: "GB",
    share: 0.12,
    cities: [
      ["London", 51.5072, -0.1276],
      ["Birmingham", 52.4862, -1.8904],
      ["Manchester", 53.4808, -2.2426],
      ["Leeds", 53.8008, -1.5491],
      ["Bristol", 51.4545, -2.5879],
    ],
  },
  IT: {
    code: "IT",
    share: 0.1,
    cities: [
      ["Milano", 45.4642, 9.19],
      ["Roma", 41.9028, 12.4964],
      ["Torino", 45.0703, 7.6869],
      ["Bologna", 44.4949, 11.3426],
    ],
  },
  SE: {
    code: "SE",
    share: 0.07,
    cities: [
      ["Stockholm", 59.3293, 18.0686],
      ["Göteborg", 57.7089, 11.9746],
      ["Malmö", 55.605, 13.0038],
    ],
  },
  DK: {
    code: "DK",
    share: 0.05,
    cities: [
      ["København", 55.6761, 12.5683],
      ["Aarhus", 56.1629, 10.2039],
      ["Odense", 55.4038, 10.4024],
    ],
  },
  PL: {
    code: "PL",
    share: 0.07,
    cities: [
      ["Warszawa", 52.2297, 21.0122],
      ["Kraków", 50.0647, 19.945],
      ["Wrocław", 51.1079, 17.0385],
    ],
  },
  CZ: {
    code: "CZ",
    share: 0.05,
    cities: [
      ["Praha", 50.0755, 14.4378],
      ["Brno", 49.1951, 16.6068],
    ],
  },
  AT: {
    code: "AT",
    share: 0.05,
    cities: [
      ["Wien", 48.2082, 16.3738],
      ["Graz", 47.0707, 15.4395],
      ["Linz", 48.3069, 14.2858],
    ],
  },
  HU: {
    code: "HU",
    share: 0.03,
    cities: [
      ["Budapest", 47.4979, 19.0402],
      ["Debrecen", 47.5316, 21.6273],
    ],
  },
  RO: {
    code: "RO",
    share: 0.02,
    cities: [
      ["București", 44.4268, 26.1025],
      ["Cluj-Napoca", 46.7712, 23.6236],
    ],
  },
};

const SITE_KINDS = [
  "Retail park",
  "Supermarket",
  "Motorway services",
  "City hub",
  "Hotel",
  "Office park",
  "Furniture store",
  "DIY store",
] as const;
const VENDORS: Array<[string, string, number[], string[]]> = [
  ["Alpitronic", "HYC300", [150, 300], ["1.9.4", "1.10.2"]],
  ["ABB", "Terra 184", [180], ["4.1.0", "4.2.1"]],
  ["Kempower", "S-Series", [150, 300], ["2.7.0", "2.8.3"]],
  ["Compleo", "Duo", [22], ["3.0.5", "3.1.0"]],
  ["Mennekes", "AMTRON", [22], ["5.22.0"]],
];
const TECHNICIANS = [
  "N. Wagner",
  "A. Kowalski",
  "M. Rossi",
  "S. de Vries",
  "J. Smith",
  "E. Lindqvist",
  "P. Novák",
  "L. Horváth",
  "R. Popescu",
  "K. Hansen",
];

export const CAUSES = ["rcd_trip", "cable_damage", "comms_loss", "overheating", "payment_terminal", "firmware_crash"] as const;
export type Cause = (typeof CAUSES)[number];

/** Which OCPP 1.6 error codes each cause tends to produce. Signatures overlap on purpose. */
const SIGNATURES: Record<Cause, Array<[string, number]>> = {
  rcd_trip: [
    ["GroundFailure", 6],
    ["OverCurrentFailure", 2],
    ["OtherError", 1],
  ],
  cable_damage: [
    ["ConnectorLockFailure", 4],
    ["GroundFailure", 3],
    ["EVCommunicationError", 3],
  ],
  comms_loss: [
    ["OtherError", 3],
    ["WeakSignal", 4],
    ["InternalError", 1],
  ],
  overheating: [
    ["HighTemperature", 6],
    ["PowerSwitchFailure", 2],
    ["OverCurrentFailure", 2],
  ],
  payment_terminal: [
    ["ReaderFailure", 8],
    ["OtherError", 1],
  ],
  firmware_crash: [
    ["InternalError", 5],
    ["EVCommunicationError", 2],
    ["ResetFailure", 2],
  ],
};
const TITLES: Record<Cause, string[]> = {
  rcd_trip: ["Trips during charging", "RCD trips after rain", "Stops after a few minutes"],
  cable_damage: ["Cable does not lock", "Connector damaged", "Charging aborts on connect"],
  comms_loss: ["Offline in backend", "No heartbeat since morning", "Shows unavailable"],
  overheating: ["Derates and stops", "Too hot, stops charging", "Power drops in the afternoon"],
  payment_terminal: ["Card reader not working", "RFID not accepted", "Payment terminal dark"],
  firmware_crash: ["Reboots repeatedly", "Frozen display", "Restarts during session"],
};

export interface ChargePoint {
  id: string;
  site: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  powerKw: number;
  vendor: string;
  model: string;
  firmware: string;
  status: string;
  lastSeen: string;
}
export interface StatusEvent {
  cpId: string;
  country: string;
  at: string;
  connector: number;
  status: string;
  errorCode: string;
  vendorErrorCode: string | null;
}
export interface Ticket {
  id: string;
  cpId: string;
  country: string;
  title: string;
  status: "open" | "closed";
  opened: string;
  closed: string | null;
  technician: string;
  resolutionCause: Cause | null;
  /** the real cause, kept apart from what the technician recorded; only the simulator knows it */
  trueCause: Cause;
}
export interface MonthRow {
  month: string;
  site: string;
  country: string;
  sessions: number;
  kwh: number;
  revenueEur: number;
}
export interface Contract {
  partner: string;
  site: string;
  country: string;
  startDate: string;
  endDate: string;
  revenueSharePct: number;
  rentEurMonth: number;
}

export interface World {
  now: Date;
  chargepoints: ChargePoint[];
  events: StatusEvent[];
  tickets: Ticket[];
  months: MonthRow[];
  contracts: Contract[];
}

const iso = (d: Date) => d.toISOString();
const day = 86_400_000;

const causeWeights = (cp: ChargePoint, r: Rng): Cause => {
  const hp = cp.powerKw >= 150;
  const buggyFirmware = cp.firmware === "4.2.1" || cp.firmware === "2.7.0";
  return r.weighted<Cause>([
    ["rcd_trip", 3],
    ["cable_damage", hp ? 3 : 2],
    ["comms_loss", 3],
    ["overheating", hp ? 3 : 0.5],
    ["payment_terminal", 2],
    ["firmware_crash", buggyFirmware ? 4 : 1],
  ]);
};

export const buildWorld = (opts: { chargepoints?: number; seed?: number; now?: Date } = {}): World => {
  const r = rng(opts.seed ?? 2026);
  const n = opts.chargepoints ?? 9000;
  const now = opts.now ?? new Date("2026-10-29T12:00:00Z");
  const chargepoints: ChargePoint[] = [];
  const sites: Array<{ name: string; country: string; city: string }> = [];
  let serial = 1000;
  for (const c of Object.values(COUNTRIES)) {
    const target = Math.round(n * c.share);
    let made = 0;
    while (made < target) {
      const [city, lat, lon] = r.pick(c.cities);
      const site = `${city} ${r.pick(SITE_KINDS)} ${r.int(1, 40)}`;
      if (sites.some((s) => s.name === site)) continue;
      sites.push({ name: site, country: c.code, city });
      const [vendor, model, powers, firmwares] = r.pick(VENDORS);
      const count = Math.min(target - made, r.int(2, 6));
      const slat = lat + r.normal(0, 0.04);
      const slon = lon + r.normal(0, 0.06);
      for (let i = 0; i < count; i++) {
        serial += 1;
        chargepoints.push({
          id: `${c.code}*EDR*E${serial}`,
          site,
          city,
          country: c.code,
          lat: Math.round((slat + r.normal(0, 0.0003)) * 1e6) / 1e6,
          lon: Math.round((slon + r.normal(0, 0.0003)) * 1e6) / 1e6,
          powerKw: r.pick(powers),
          vendor,
          model,
          firmware: r.pick(firmwares),
          status: "Available",
          lastSeen: iso(new Date(now.getTime() - r.int(5, 600) * 1000)),
        });
        made += 1;
      }
    }
  }

  // fault episodes over the last 60 days
  const events: StatusEvent[] = [];
  const tickets: Ticket[] = [];
  let ticketNo = 4000;
  const episodes = Math.round(n * 0.38);
  for (let e = 0; e < episodes; e++) {
    const cp = r.pick(chargepoints);
    const cause = causeWeights(cp, r);
    const start = new Date(now.getTime() - r.int(1, 60) * day + r.int(0, 86_399) * 1000);
    const count = r.int(2, cause === "comms_loss" ? 6 : 12);
    const connectors = cause === "comms_loss" || cause === "firmware_crash" || cause === "payment_terminal" ? [1, 2] : [r.int(1, 2)];
    let t = start.getTime();
    for (let i = 0; i < count; i++) {
      t += r.int(5, cause === "rcd_trip" ? 240 : 720) * 60_000;
      if (t > now.getTime()) break;
      const code = r.weighted(SIGNATURES[cause]);
      const status =
        cause === "comms_loss" || cause === "firmware_crash"
          ? r.weighted([
              ["Unavailable", 3],
              ["Faulted", 1],
            ] as const)
          : "Faulted";
      for (const conn of connectors)
        events.push({
          cpId: cp.id,
          country: cp.country,
          at: iso(new Date(t)),
          connector: conn,
          status,
          errorCode: code,
          vendorErrorCode: r.next() < 0.6 ? `${cp.vendor.slice(0, 2).toUpperCase()}-${r.int(100, 999)}` : null,
        });
    }
    const opened = new Date(Math.min(t + r.int(10, 240) * 60_000, now.getTime() - 60_000));
    const open = now.getTime() - opened.getTime() < 3 * day && r.next() < 0.7;
    const recorded: Cause = r.next() < 0.085 ? r.pick(CAUSES.filter((x) => x !== cause)) : cause;
    ticketNo += 1;
    tickets.push({
      id: `T-${ticketNo}`,
      cpId: cp.id,
      country: cp.country,
      title: r.pick(TITLES[cause]),
      status: open ? "open" : "closed",
      opened: iso(opened),
      closed: open ? null : iso(new Date(Math.min(opened.getTime() + r.int(4, 96) * 3_600_000, now.getTime()))),
      technician: r.pick(TECHNICIANS),
      resolutionCause: open ? null : recorded,
      trueCause: cause,
    });
    if (open) cp.status = events.filter((x) => x.cpId === cp.id).at(-1)?.status ?? "Faulted";
  }
  // background noise: brief, harmless notifications
  for (let i = 0; i < n * 3; i++) {
    const cp = r.pick(chargepoints);
    events.push({
      cpId: cp.id,
      country: cp.country,
      at: iso(new Date(now.getTime() - r.int(1, 60 * 24 * 60) * 60_000)),
      connector: r.int(1, 2),
      status: r.weighted([
        ["Charging", 6],
        ["Available", 6],
        ["SuspendedEV", 1],
        ["Finishing", 2],
      ] as const),
      errorCode: "NoError",
      vendorErrorCode: null,
    });
  }
  for (const cp of chargepoints) if (cp.status === "Available" && r.next() < 0.28) cp.status = "Charging";

  // 24 months of sessions per site, with growth and seasonality
  const months: MonthRow[] = [];
  const contracts: Contract[] = [];
  const PARTNERS = [
    "Ruhr Retail GmbH",
    "Nordic Malls AB",
    "Autogrill Partners",
    "CityPark BV",
    "Hotelgruppe Mitte",
    "Baumarkt Holding",
    "Office Estates plc",
    "Central Retail Sp. z o.o.",
  ];
  for (const s of sites) {
    const cps = chargepoints.filter((c) => c.site === s.name);
    const kw = cps.reduce((a, c) => a + c.powerKw, 0);
    const base = kw * r.normal(1.9, 0.4);
    const price =
      { DE: 0.59, NL: 0.55, GB: 0.68, IT: 0.62, SE: 0.48, DK: 0.5, PL: 0.45, CZ: 0.44, AT: 0.57, HU: 0.42, RO: 0.4 }[s.country] ?? 0.5;
    for (let m = 23; m >= 0; m--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - m, 1));
      const season = 1 + 0.12 * Math.sin(((d.getUTCMonth() - 3) / 12) * 2 * Math.PI);
      const growth = 1 + (23 - m) * 0.02;
      const kwh = Math.max(0, Math.round(base * season * growth * r.normal(1, 0.08) * 10) / 10);
      const sessions = Math.max(0, Math.round(kwh / r.normal(24, 3)));
      months.push({
        month: d.toISOString().slice(0, 10),
        site: s.name,
        country: s.country,
        sessions,
        kwh,
        revenueEur: Math.round(kwh * price * 100) / 100,
      });
    }
    const startYear = r.int(2020, 2025);
    contracts.push({
      partner: r.pick(PARTNERS),
      site: s.name,
      country: s.country,
      startDate: `${startYear}-${String(r.int(1, 12)).padStart(2, "0")}-01`,
      endDate: `${startYear + r.int(8, 15)}-12-31`,
      revenueSharePct: Math.round(r.normal(7, 2) * 10) / 10,
      rentEurMonth: r.next() < 0.4 ? Math.round(r.normal(900, 300)) : 0,
    });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : 1));
  return { now, chargepoints, events, tickets, months, contracts };
};
