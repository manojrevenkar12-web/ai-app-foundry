import { Link } from "@tanstack/react-router";
import { QueryView } from "../../components/QueryView";
import { EmptyState, PageHead, Skeleton } from "../../components/ui";
import { euros, when } from "../../lib/format";
import { useAudit, useAuditVerify, useMe, useOverview } from "../../lib/queries";

const AuditPanel = () => {
  const verify = useAuditVerify();
  const log = useAudit();
  return (
    <section className="section">
      <div className="spread">
        <h2>Audit log</h2>
        <QueryView query={verify} skeleton={<Skeleton lines={1} label="Verifying the chain" />}>
          {(v) => (
            <span className={`tag ${v.ok ? "tag--ok" : "tag--fault"}`} role="status">
              {v.ok ? `Hash chain intact over ${v.records.toLocaleString("en-GB")} records` : `Chain broken at record ${v.brokenAt}`}
            </span>
          )}
        </QueryView>
      </div>
      <p className="lead">
        Every sign-in, submission, decision, publication and confirmed write. Records cannot be changed or deleted; each one hashes the one
        before.
      </p>
      <QueryView query={log} skeleton={<Skeleton lines={6} label="Loading the audit log" />} empty={<EmptyState title="No records yet" />}>
        {(rows) => (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">On</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seq}>
                    <td className="num">{r.seq}</td>
                    <td>{when(r.at)}</td>
                    <td>{r.action}</td>
                    <td>{r.target}</td>
                    <td className="clip">{JSON.stringify(r.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
    </section>
  );
};

export const Operations = () => {
  const q = useOverview();
  const me = useMe();
  const admin = me.data?.roles.includes("Foundry.Admin");
  return (
    <>
      <PageHead title="Operations">
        The last 24 hours across the platform: which apps are used, how they fail, how long they take and what their model calls cost.
      </PageHead>
      <QueryView
        query={q}
        skeleton={<Skeleton lines={5} label="Loading usage" />}
        empty={<EmptyState title="No calls in the last 24 hours">Usage appears here as soon as someone runs an app.</EmptyState>}
      >
        {(rows) => (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">App</th>
                  <th scope="col" className="num">
                    Calls
                  </th>
                  <th scope="col" className="num">
                    Failed
                  </th>
                  <th scope="col" className="num">
                    p95 (ms)
                  </th>
                  <th scope="col" className="num">
                    People
                  </th>
                  <th scope="col" className="num">
                    Model cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.app_id}>
                    <td>
                      <Link to="/apps/$id/manage" params={{ id: r.app_id }}>
                        {r.app_id}
                      </Link>
                    </td>
                    <td className="num">{r.calls.toLocaleString("en-GB")}</td>
                    <td className="num">{r.calls ? `${((r.failures / r.calls) * 100).toFixed(1)}%` : "–"}</td>
                    <td className="num">{r.p95_ms.toLocaleString("en-GB")}</td>
                    <td className="num">{r.viewers}</td>
                    <td className="num">{euros(r.cost_micro_eur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
      {admin && <AuditPanel />}
    </>
  );
};
