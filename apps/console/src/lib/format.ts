/** Formats for result views and figures. */
const nf = new Intl.NumberFormat("en-GB");
const eur = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eurSmall = new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

export const at = (v: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

export const format = (v: unknown, f: "text" | "number" | "eur" | "percent" | "datetime" | "status" = "text"): string => {
  if (v === null || v === undefined || v === "") return "";
  if (f === "number" && typeof v === "number") return nf.format(v);
  if (f === "eur" && typeof v === "number") return eur.format(v);
  if (f === "percent" && typeof v === "number") return `${(v * 100).toFixed(1)}%`;
  if (f === "datetime" && (typeof v === "string" || typeof v === "number")) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : dt.format(d);
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
};

export const euros = (micro: string | number) => eurSmall.format(Number(micro) / 1e6);
export const when = (iso: string) => dt.format(new Date(iso));
export const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;
