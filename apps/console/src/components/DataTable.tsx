import { useState } from "react";
import { at, format } from "../lib/format";
import { StatusTag } from "./ui";

export interface Col {
  key: string;
  label: string;
  format?: "text" | "number" | "eur" | "percent" | "datetime" | "status";
}

const NUMERIC = new Set(["number", "eur", "percent"]);
/** rows shown before "Show all" */
const PAGE = 25;

export const DataTable = ({ rows, columns, caption }: { rows: unknown[]; columns: Col[]; caption?: string }) => {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, PAGE);
  return (
    <div>
      <div className="table-wrap">
        <table className="data">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={NUMERIC.has(c.format ?? "") ? "num" : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no guaranteed key
              <tr key={i}>
                {columns.map((c) => {
                  const v = at(r, c.key);
                  return (
                    <td key={c.key} className={NUMERIC.has(c.format ?? "") ? "num" : "clip"}>
                      {c.format === "status" && typeof v === "string" ? <StatusTag status={v} /> : format(v, c.format)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PAGE && (
        <div className="block__actions">
          <button type="button" className="btn btn--small" onClick={() => setAll(!all)}>
            {all ? `Show the first ${PAGE}` : `Show all ${rows.length} rows`}
          </button>
        </div>
      )}
    </div>
  );
};
