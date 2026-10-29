import { type Reach, WiringPlate } from "../../components/WiringPlate";
import { short } from "../../lib/format";
import type { Finding, GateReport } from "../../lib/types";

const ORDER = { block: 0, warn: 1, info: 2 } as const;
const TAG = { block: "tag--fault", warn: "tag--warn", info: "" } as const;
const WORD = { block: "Blocks", warn: "Review", info: "Note" } as const;

export const reachOfReport = (r: GateReport): Reach | null =>
  r.capabilities
    ? {
        audience: r.capabilities.audience,
        connectors: r.capabilities.connectors.map((c) => ({ ...c, access: c.access === "write" ? "write" : "read" })),
        models: r.capabilities.models.map((m) => ({ alias: m.alias, maxTokensPerCall: m.maxTokensPerCall ?? 1024 })),
        collections: r.capabilities.collections,
        budget: r.capabilities.budget,
      }
    : null;

export const Findings = ({ findings, onLine }: { findings: Finding[]; onLine?: (line: number) => void }) =>
  findings.length === 0 ? (
    <p className="muted small">No findings.</p>
  ) : (
    <ul className="findings">
      {[...findings]
        .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
        .map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: findings can repeat a rule
          <li key={i} className="finding">
            <span className={`tag ${TAG[f.severity]}`}>{WORD[f.severity]}</span>
            <span className="finding__rule">
              {f.rule}
              {f.line ? (
                onLine ? (
                  <>
                    {" "}
                    <button type="button" className="btn btn--quiet btn--small" onClick={() => onLine(f.line as number)}>
                      line {f.line}
                    </button>
                  </>
                ) : (
                  ` line ${f.line}`
                )
              ) : f.at ? (
                ` ${f.at}`
              ) : null}
            </span>
            <p>{f.message}</p>
          </li>
        ))}
    </ul>
  );

/** What the publish gate found: the verdict, the review it needs, findings, the app's tests and its reach. */
export const Report = ({ report, name, previous }: { report: GateReport; name: string; previous?: Reach | null }) => {
  const blocks = report.findings.filter((f) => f.severity === "block").length;
  const failed = report.tests.filter((t) => !t.ok).length;
  const reach = reachOfReport(report);
  return (
    <div className="blocks">
      <div className={`verdict verdict--${report.ok ? "ok" : "block"}`} role="status">
        {report.ok
          ? "Passes the checks"
          : `Blocked: ${blocks} finding${blocks === 1 ? "" : "s"}${failed ? `, ${failed} failing test${failed === 1 ? "" : "s"}` : ""}`}
      </div>
      {report.tier && (
        <section className="panel">
          <h3>
            {report.tier.tier === 0
              ? "Publishes without a reviewer"
              : report.tier.tier === 1
                ? "Needs a second builder to approve"
                : "Needs a platform reviewer to approve"}
          </h3>
          <ul className="small">
            {report.tier.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {report.hash && <p className="small muted">Bundle {short(report.hash)}. Approval is for exactly this bundle.</p>}
        </section>
      )}
      {reach && (
        <WiringPlate
          name={name}
          reach={reach}
          previous={previous ?? undefined}
          title="What it will reach"
          caption="As declared in the manifest; the platform enforces it on every call."
        />
      )}
      <section className="panel">
        <h3>Findings</h3>
        <Findings findings={report.findings} />
      </section>
      <section className="panel">
        <h3>The app's tests</h3>
        {report.tests.length === 0 ? (
          <p className="muted small">No tests ran.</p>
        ) : (
          <ul className="findings">
            {report.tests.map((t) => (
              <li key={t.name} className="finding">
                <span className={`tag ${t.ok ? "tag--ok" : "tag--fault"}`}>{t.ok ? "Passed" : "Failed"}</span>
                <span className="finding__rule">
                  {t.name} ({Math.round(t.ms)} ms)
                </span>
                {!t.ok && <p>{t.message}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
