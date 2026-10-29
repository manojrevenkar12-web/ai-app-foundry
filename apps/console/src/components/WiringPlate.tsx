import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";
import type { Audience, Collection, Manifest, Platform } from "../lib/types";
import { DURATION, EASE, STAGGER } from "../theme/motion";

/**
 * The wiring plate: what an app is connected to, drawn like the label inside a distribution board.
 * Conductor colours carry meaning: blue reads, brown is confidential (two conductors), a breaker
 * sits on every write (the viewer closes it), green-and-yellow marks data kept per person.
 */
export interface Reach {
  audience: Audience;
  connectors: Array<{ id: string; title: string; access: "read" | "write"; classification: string; external: boolean }>;
  models: Array<{ alias: string; maxTokensPerCall: number }>;
  collections: Collection[];
  budget?: Manifest["budget"];
}

/** Reach from a manifest and the platform's connector catalogue. */
export const reachOf = (
  m: Pick<Manifest, "audience" | "connectors" | "models" | "collections"> & { budget?: Manifest["budget"] },
  platform: Platform | undefined,
): Reach => ({
  audience: m.audience,
  connectors: m.connectors.map((c) => {
    const def = platform?.connectors.find((d) => d.id === c.id);
    return {
      id: c.id,
      title: def?.title ?? c.id,
      access: def?.access ?? "read",
      classification: def?.classification ?? "internal",
      external: def?.external ?? false,
    };
  }),
  models: m.models.map((x) => ({ alias: x.alias, maxTokensPerCall: x.maxTokensPerCall ?? 1024 })),
  collections: m.collections,
  ...(m.budget ? { budget: m.budget } : {}),
});

type Kind = "read" | "confidential" | "write" | "external" | "model" | "private" | "shared";
interface Row {
  key: string;
  title: string;
  sub: string;
  kind: Kind;
  state: "same" | "new" | "removed";
}

const G = {
  width: 330,
  pad: 10,
  unitX: 2,
  unitW: 84,
  wireEnd: 146,
  labelX: 158,
  row: 44,
  groupHead: 28,
  breakerAt: 112,
  double: 2.5,
  terminalR: 5,
  fenceX: 134,
} as const;

const audienceText = (a: Audience) =>
  a.kind === "owner" ? "only its owner" : a.kind === "company" ? "everyone at EDRI" : a.groups.join(", ");

const rowsOf = (r: Reach) => {
  const connectors: Row[] = r.connectors.map((c) => ({
    key: `c:${c.id}`,
    title: c.title,
    sub:
      c.access === "write"
        ? c.external
          ? "sends outside EDRI after you confirm"
          : "changes data after you confirm"
        : c.classification === "confidential"
          ? "reads confidential data"
          : `reads ${c.classification} data`,
    kind: c.access === "write" ? (c.external ? "external" : "write") : c.classification === "confidential" ? "confidential" : "read",
    state: "same",
  }));
  const models: Row[] = r.models.map((m) => ({
    key: `m:${m.alias}`,
    title: `Model “${m.alias}”`,
    sub: `up to ${m.maxTokensPerCall.toLocaleString("en-GB")} tokens a call`,
    kind: "model",
    state: "same",
  }));
  const collections: Row[] = r.collections.map((c) => ({
    key: `s:${c.name}`,
    title: `Collection “${c.name}”`,
    sub: `${c.scope === "private" ? "kept per person" : "shared by everyone using it"}, ${c.retentionDays} days`,
    kind: c.classification === "confidential" ? "confidential" : c.scope,
    state: "same",
  }));
  return { connectors, models, collections };
};

/** Marks rows added since `previous`, and adds the ones it removed. */
const diff = (now: Row[], before: Row[] | undefined): Row[] => {
  if (!before) return now;
  const had = new Set(before.map((r) => r.key));
  const has = new Set(now.map((r) => r.key));
  return [
    ...now.map((r) => ({ ...r, state: had.has(r.key) ? ("same" as const) : ("new" as const) })),
    ...before.filter((r) => !has.has(r.key)).map((r) => ({ ...r, sub: "removed in this version", state: "removed" as const })),
  ];
};

const wrap = (s: string, max: number) => {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${w}`.length <= max) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w.length > max ? `${w.slice(0, max - 1)}…` : w);
  }
  return lines.slice(0, 3);
};

const NAME_CHARS = 9;

export const WiringPlate = ({
  name,
  reach,
  previous,
  title = "What this app can reach",
  caption,
}: {
  name: string;
  reach: Reach;
  previous?: Reach;
  title?: string;
  caption?: string;
}) => {
  const reduce = useReducedMotion();
  const id = useId();
  const now = rowsOf(reach);
  const before = previous ? rowsOf(previous) : undefined;
  const groups = [
    { label: "Data and systems", rows: diff(now.connectors, before?.connectors) },
    { label: "Models", rows: diff(now.models, before?.models) },
    { label: "Storage", rows: diff(now.collections, before?.collections) },
  ].filter((g) => g.rows.length > 0);

  let y = G.pad;
  const placed = groups.map((g) => {
    const headY = y + G.groupHead - 10;
    y += G.groupHead;
    const rows = g.rows.map((r) => {
      const cy = y + G.row / 2;
      y += G.row;
      return { ...r, cy };
    });
    return { ...g, headY, rows };
  });
  const height = Math.max(y + G.pad, 150);
  const all = placed.flatMap((g) => g.rows);
  const anyExternal = all.some((r) => r.kind === "external" && r.state !== "removed");
  const nameLines = wrap(name, NAME_CHARS);

  const draw = (i: number) =>
    reduce
      ? {}
      : {
          initial: { pathLength: 0 },
          animate: { pathLength: 1 },
          transition: { duration: DURATION.wire, ease: EASE, delay: i * STAGGER * 2 },
        };

  return (
    <figure className="plate" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`}>{title}</h3>
      <p>{caption ?? `Open to ${audienceText(reach.audience)}. It acts as the person using it, so it sees only what they may see.`}</p>
      <svg viewBox={`0 0 ${G.width} ${height}`} role="img" aria-labelledby={`${id}-st ${id}-d`}>
        <title id={`${id}-st`}>{`Connections of ${name}`}</title>
        <desc id={`${id}-d`}>
          {all.length === 0
            ? "No connections: the app uses only what you type into it."
            : all.map((r) => `${r.title}: ${r.sub}${r.state === "new" ? " (new)" : ""}`).join(". ")}
        </desc>
        <rect className="unit" x={G.unitX} y={G.pad} width={G.unitW} height={height - G.pad * 2} rx={6} />
        {nameLines.map((l, i) => (
          <text key={l} className="unit-name" x={G.unitX + 9} y={G.pad + 24 + i * 17}>
            {l}
          </text>
        ))}
        <text className="t-sub" x={G.unitX + 9} y={G.pad + 24 + nameLines.length * 17 + 4}>
          {reach.audience.kind === "owner" ? "private" : reach.audience.kind === "company" ? "everyone" : "groups"}
        </text>
        {reach.budget && (
          <text className="t-sub" x={G.unitX + 9} y={height - G.pad - 12}>
            €{reach.budget.eurPerDay} a day
          </text>
        )}
        {anyExternal && (
          <>
            <line className="fence" x1={G.fenceX} x2={G.fenceX} y1={G.pad} y2={height - G.pad} />
            <text className="t-sub" x={G.fenceX - 4} y={height - G.pad - 2} textAnchor="end">
              EDRI
            </text>
          </>
        )}
        {placed.map((g) => (
          <text key={g.label} className="t-group" x={G.labelX - 14} y={g.headY}>
            {g.label}
          </text>
        ))}
        {all.length === 0 && (
          <text className="t-sub" x={G.labelX - 14} y={height / 2}>
            Nothing outside the app
          </text>
        )}
        {all.map((r, i) => {
          const x0 = G.unitX + G.unitW;
          const removed = r.state === "removed";
          const cls = removed
            ? "wire--removed"
            : r.kind === "confidential" || r.kind === "write" || r.kind === "external"
              ? "wire--phase"
              : r.kind === "private"
                ? "wire--earth"
                : "wire--neutral";
          const doubled = !removed && r.kind === "confidential";
          const breaker = !removed && (r.kind === "write" || r.kind === "external");
          const path = (dy: number) =>
            breaker
              ? `M ${x0} ${r.cy + dy} H ${G.breakerAt - 10} M ${G.breakerAt + 12} ${r.cy + dy} H ${G.wireEnd}`
              : `M ${x0} ${r.cy + dy} H ${G.wireEnd}`;
          return (
            <g key={r.key}>
              {doubled ? (
                <>
                  <motion.path className={`wire ${cls}`} d={path(-G.double)} {...draw(i)} />
                  <motion.path className={`wire ${cls}`} d={path(G.double)} {...draw(i)} />
                </>
              ) : (
                <motion.path className={`wire ${cls}`} d={path(0)} {...draw(i)} />
              )}
              {!removed && r.kind === "private" && <motion.path className="wire wire--earth-y" d={path(0)} {...draw(i)} />}
              {breaker && (
                <g>
                  <circle className="breaker" cx={G.breakerAt - 10} cy={r.cy} r={2.5} />
                  <circle className="breaker" cx={G.breakerAt + 12} cy={r.cy} r={2.5} />
                  <line className="breaker" x1={G.breakerAt - 8} y1={r.cy - 1} x2={G.breakerAt + 10} y2={r.cy - 11} />
                </g>
              )}
              {r.kind === "external" && !removed ? (
                <path className="breaker" d={`M ${G.wireEnd - 6} ${r.cy - 6} L ${G.wireEnd + 2} ${r.cy} L ${G.wireEnd - 6} ${r.cy + 6}`} />
              ) : (
                <circle
                  className={`terminal ${r.kind === "confidential" ? "terminal--phase" : ""}`}
                  cx={G.wireEnd}
                  cy={r.cy}
                  r={G.terminalR}
                />
              )}
              <text className="t-title" x={G.labelX} y={r.cy - 3} opacity={removed ? 0.55 : 1}>
                {r.title}
              </text>
              <text className="t-sub" x={G.labelX} y={r.cy + 14}>
                {r.sub}
              </text>
              {r.state === "new" && (
                <g>
                  <rect className="badge-new" x={G.width - 30} y={r.cy - 17} width={28} height={15} rx={3} />
                  <text className="badge-new-text" x={G.width - 16} y={r.cy - 6} textAnchor="middle">
                    new
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="plate-key">
        <span>
          <svg viewBox="0 0 26 10" aria-hidden="true">
            <path className="wire wire--neutral" d="M1 5 H25" />
          </svg>
          reads
        </span>
        <span>
          <svg viewBox="0 0 26 10" aria-hidden="true">
            <path className="wire wire--phase" d="M1 2.5 H25 M1 7.5 H25" />
          </svg>
          confidential
        </span>
        <span>
          <svg viewBox="0 0 26 10" aria-hidden="true">
            <path className="wire wire--phase" d="M1 7 H8 M18 7 H25" />
            <line className="breaker" x1="9" y1="7" x2="17" y2="1" />
          </svg>
          writes after you confirm
        </span>
        <span>
          <svg viewBox="0 0 26 10" aria-hidden="true">
            <path className="wire wire--earth" d="M1 5 H25" />
            <path className="wire wire--earth-y" d="M1 5 H25" />
          </svg>
          kept per person
        </span>
      </figcaption>
    </figure>
  );
};
