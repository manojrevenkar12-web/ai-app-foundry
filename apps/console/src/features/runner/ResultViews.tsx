import { Chart } from "../../components/Chart";
import { DataTable } from "../../components/DataTable";
import { Markdown } from "../../components/Markdown";
import { at, format } from "../../lib/format";
import type { ResultView } from "../../lib/types";

const asText = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : format(v));
const asRows = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

/** Renders a handler's result through the views its UI declares. */
export const ResultViews = ({ views, value }: { views: ResultView[]; value: unknown }) => (
  <div className="results">
    {views.map((v, i) => {
      const key = `${v.type}-${i}`;
      switch (v.type) {
        case "markdown": {
          const t = asText(at(value, v.path));
          return t ? <Markdown key={key} text={t} /> : null;
        }
        case "stats":
          return (
            <dl key={key} className="stats">
              {v.items.map((s) => (
                <div key={s.path} className="stat">
                  <dt>{s.label}</dt>
                  <dd>{format(at(value, s.path), s.format) || "–"}</dd>
                </div>
              ))}
            </dl>
          );
        case "table": {
          const rows = asRows(at(value, v.path));
          return rows.length ? (
            <DataTable key={key} rows={rows} columns={v.columns} />
          ) : (
            <p key={key} className="muted small">
              No rows.
            </p>
          );
        }
        case "chart": {
          const rows = asRows(at(value, v.path));
          return rows.length ? (
            <Chart key={key} rows={rows} x={v.x} y={v.y} kind={v.kind} {...(v.yLabel ? { yLabel: v.yLabel } : {})} />
          ) : null;
        }
        default:
          return null;
      }
    })}
  </div>
);
