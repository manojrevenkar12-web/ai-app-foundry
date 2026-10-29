import { useEffect, useRef, useState } from "react";
import { format } from "../lib/format";

/**
 * A small line or bar chart in SVG: one axis, up to four series, labelled ticks. The drawing is
 * as wide as its container in CSS pixels, so labels keep their size on a phone and on a wide
 * screen. Missing values (null) are gaps, not zeros.
 */
const C = { h: 240, left: 52, right: 12, top: 20, bottom: 26, ticks: 4, barGap: 0.25, maxBar: 44, minWidth: 280, fallback: 640 } as const;

const nice = (max: number) => {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  const f = max / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
};
const compact = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });

const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number>(C.fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setW(Math.max(C.minWidth, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
};

export const Chart = ({
  rows,
  x,
  y,
  kind,
  yLabel,
  labels,
}: {
  rows: Array<Record<string, unknown>>;
  x: string;
  y: string[];
  kind: "line" | "bar";
  yLabel?: string;
  labels?: Record<string, string>;
}) => {
  const { ref, w } = useWidth();
  // aggregate by x, so a chart over rows per site and month shows months
  const order: string[] = [];
  const sums = new Map<string, number[]>();
  for (const r of rows) {
    const k = format(r[x], "text");
    if (!sums.has(k)) {
      order.push(k);
      sums.set(
        k,
        y.map(() => Number.NaN),
      );
    }
    const s = sums.get(k) as number[];
    y.forEach((key, i) => {
      const raw = r[key];
      const v = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
      if (Number.isFinite(v)) s[i] = (Number.isNaN(s[i] ?? Number.NaN) ? 0 : (s[i] as number)) + v;
    });
  }
  const values = order.map((k) => sums.get(k) as number[]);
  const max = nice(Math.max(0, ...values.flat().filter(Number.isFinite)));
  const iw = w - C.left - C.right;
  const ih = C.h - C.top - C.bottom;
  const band = iw / Math.max(order.length, 1);
  const sx = (i: number) => C.left + band * i + band / 2;
  const sy = (v: number) => C.top + ih - (v / max) * ih;
  const labelEvery = Math.ceil(order.length / Math.max(2, Math.floor(iw / 72)));
  const name = (k: string) => labels?.[k] ?? k;
  const group = Math.min(band * (1 - C.barGap), C.maxBar * y.length);
  const bw = group / y.length;

  const line = (j: number) => {
    let d = "";
    let pen = false;
    values.forEach((vs, i) => {
      const v = vs[j] ?? Number.NaN;
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"} ${sx(i)} ${sy(v)} `;
      pen = true;
    });
    return d.trim();
  };

  return (
    <div ref={ref}>
      <svg
        className="chart"
        width={w}
        height={C.h}
        viewBox={`0 0 ${w} ${C.h}`}
        role="img"
        aria-label={`${kind} chart of ${y.map(name).join(", ")} by ${x}`}
      >
        {Array.from({ length: C.ticks + 1 }, (_, t) => {
          const v = (max / C.ticks) * t;
          return (
            <g key={v}>
              <line className="grid" x1={C.left} x2={w - C.right} y1={sy(v)} y2={sy(v)} />
              <text x={C.left - 6} y={sy(v) + 4} textAnchor="end">
                {compact.format(v)}
              </text>
            </g>
          );
        })}
        <line className="axis" x1={C.left} x2={w - C.right} y1={sy(0)} y2={sy(0)} />
        {order.map((k, i) =>
          i % labelEvery === 0 ? (
            <text key={k} x={sx(i)} y={C.h - 8} textAnchor="middle">
              {k}
            </text>
          ) : null,
        )}
        {yLabel && (
          <text x={C.left} y={C.top - 8}>
            {yLabel}
          </text>
        )}
        {kind === "bar"
          ? values.map((vs, i) =>
              vs.map((v, j) =>
                Number.isFinite(v) ? (
                  <rect
                    key={`${order[i]}-${y[j]}`}
                    className={`series-${j}`}
                    x={sx(i) - group / 2 + j * bw}
                    y={sy(v)}
                    width={Math.max(bw - 1, 1)}
                    height={sy(0) - sy(v)}
                  >
                    <title>{`${order[i]}: ${name(y[j] ?? "")} ${v.toLocaleString("en-GB")}`}</title>
                  </rect>
                ) : null,
              ),
            )
          : y.map((key, j) => (
              <g key={key}>
                <path className={`line series-${j}`} d={line(j)} />
                {values.map((vs, i) =>
                  Number.isFinite(vs[j] ?? Number.NaN) ? (
                    <circle key={order[i]} className={`series-${j}`} cx={sx(i)} cy={sy(vs[j] as number)} r={3}>
                      <title>{`${order[i]}: ${name(key)} ${(vs[j] as number).toLocaleString("en-GB")}`}</title>
                    </circle>
                  ) : null,
                )}
              </g>
            ))}
      </svg>
      {y.length > 1 && (
        <div className="legend">
          {y.map((k, j) => (
            <span key={k}>
              <i className={`swatch swatch-${j}`} />
              {name(k)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
