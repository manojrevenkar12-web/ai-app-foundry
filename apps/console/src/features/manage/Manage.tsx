import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Chart } from "../../components/Chart";
import { QueryView } from "../../components/QueryView";
import { Button, EmptyState, ErrorState, PageHead, Skeleton, StatusTag, TierTag } from "../../components/ui";
import { api } from "../../lib/api";
import { euros, short, when } from "../../lib/format";
import { keys, useApp, useUsage } from "../../lib/queries";
import type { UsageDay, VersionSummary } from "../../lib/types";

const DAYS = 14;
/** Every day of the period, with zeros for days without calls, so the charts show quiet days too. */
const lastDays = (found: UsageDay[], n: number): UsageDay[] => {
  const by = new Map(found.map((d) => [d.day, d]));
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.now() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return (
      by.get(day) ?? {
        day,
        calls: 0,
        failures: 0,
        p95_ms: null,
        tokens_in: 0,
        tokens_out: 0,
        cost_micro_eur: "0",
        cache_hits: 0,
        viewers: 0,
      }
    );
  });
};

const Usage = ({ id }: { id: string }) => {
  const q = useUsage(id);
  return (
    <QueryView
      query={q}
      skeleton={<Skeleton lines={5} label="Loading usage" />}
      empty={
        <EmptyState title="Nobody has used it in the last 14 days">Calls, latency and cost appear here once people use the app.</EmptyState>
      }
    >
      {(found: UsageDay[]) => {
        const days = lastDays(found, DAYS);
        const total = days.reduce(
          (s, d) => ({
            calls: s.calls + d.calls,
            failures: s.failures + d.failures,
            cost: s.cost + Number(d.cost_micro_eur),
            hits: s.hits + d.cache_hits,
          }),
          { calls: 0, failures: 0, cost: 0, hits: 0 },
        );
        return (
          <>
            <dl className="stats">
              <div className="stat">
                <dt>Calls</dt>
                <dd>{total.calls.toLocaleString("en-GB")}</dd>
              </div>
              <div className="stat">
                <dt>Failed</dt>
                <dd>{total.calls ? `${((total.failures / total.calls) * 100).toFixed(1)}%` : "–"}</dd>
              </div>
              <div className="stat">
                <dt>Model cost</dt>
                <dd>{euros(total.cost)}</dd>
              </div>
              <div className="stat">
                <dt>Answered from cache</dt>
                <dd>{total.hits.toLocaleString("en-GB")}</dd>
              </div>
            </dl>
            <div className="section">
              <Chart
                rows={days.map((d) => ({ ...d, day: d.day.slice(5) }))}
                x="day"
                y={["calls", "failures"]}
                kind="bar"
                labels={{ calls: "Calls", failures: "Failed" }}
              />
            </div>
            <div className="section">
              <Chart rows={days.map((d) => ({ ...d, day: d.day.slice(5) }))} x="day" y={["p95_ms"]} kind="line" yLabel="p95 latency (ms)" />
            </div>
          </>
        );
      }}
    </QueryView>
  );
};

const Versions = ({ id, versions, live }: { id: string; versions: VersionSummary[]; live: number | null }) => {
  const qc = useQueryClient();
  const publish = useMutation({
    mutationFn: (n: number) => api.post(`/v1/apps/${id}/versions/${n}/publish`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.app(id) });
      void qc.invalidateQueries({ queryKey: keys.catalog });
    },
  });
  return (
    <>
      {publish.isError && <ErrorState error={publish.error} compact />}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Review</th>
              <th scope="col">Submitted</th>
              <th scope="col">Decisions</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              const canPublish = ["approved", "superseded"].includes(v.status);
              return (
                <tr key={v.number}>
                  <td>
                    {v.number} <span className="muted">{short(v.bundle_hash)}</span>
                  </td>
                  <td>
                    <StatusTag status={v.status} />
                  </td>
                  <td>
                    <TierTag tier={v.tier} pending={!["approved", "live", "superseded"].includes(v.status)} />
                  </td>
                  <td>
                    {v.created_by_name}, {when(v.created_at)}
                  </td>
                  <td className="clip">
                    {v.decisions.length === 0
                      ? "–"
                      : v.decisions
                          .map(
                            (d) =>
                              `${d.reviewer} ${d.decision === "approve" ? "approved" : "rejected"}${d.comment ? `: ${d.comment}` : ""}`,
                          )
                          .join("; ")}
                  </td>
                  <td>
                    {canPublish && (
                      <Button
                        small
                        variant={live && v.number < live ? "default" : "primary"}
                        disabled={publish.isPending}
                        onClick={() => publish.mutate(v.number)}
                      >
                        {live && v.number < live ? "Roll back to this" : "Publish"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

export const Manage = ({ id }: { id: string }) => {
  const q = useApp(id);
  const qc = useQueryClient();
  const fid = useId();
  const [reason, setReason] = useState("");
  const disable = useMutation({
    mutationFn: () => api.post(`/v1/apps/${id}/disable`, { reason }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.app(id) }),
  });
  return (
    <QueryView query={q} skeleton={<Skeleton lines={8} label="Loading the app" />}>
      {(a) => {
        const live = a.live?.number ?? null;
        return (
          <>
            <PageHead
              title={a.name}
              actions={
                <>
                  {a.status === "live" && (
                    <Link to="/apps/$id" params={{ id }} className="btn">
                      Open
                    </Link>
                  )}
                  {a.mine && (
                    <Link to="/build" search={{ from: id }} className="btn btn--primary">
                      New version
                    </Link>
                  )}
                </>
              }
            >
              {a.description}
            </PageHead>
            <section className="section">
              <h2>Versions</h2>
              {a.versions && a.versions.length > 0 ? (
                <Versions id={id} versions={a.versions} live={live} />
              ) : (
                <EmptyState title="No versions">Submit a version from the builder.</EmptyState>
              )}
            </section>
            <section className="section">
              <h2>Use in the last 14 days</h2>
              <Usage id={id} />
            </section>
            {a.status === "live" && a.mine && (
              <section className="section panel">
                <h2>Switch the app off</h2>
                <p className="lead">People can no longer open it. Its versions and data stay; publishing a version switches it on again.</p>
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    disable.mutate();
                  }}
                >
                  <label htmlFor={`${fid}-r`} className="sr-only">
                    Reason
                  </label>
                  <input
                    id={`${fid}-r`}
                    className="input"
                    placeholder="Why, for the audit log"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    minLength={3}
                    required
                  />
                  <button type="submit" className="btn" disabled={disable.isPending || reason.trim().length < 3}>
                    Switch off
                  </button>
                </form>
                {disable.isError && <ErrorState error={disable.error} compact />}
              </section>
            )}
          </>
        );
      }}
    </QueryView>
  );
};
