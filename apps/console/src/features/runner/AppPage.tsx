import { Link } from "@tanstack/react-router";
import { useCallback } from "react";
import { QueryView } from "../../components/QueryView";
import { EmptyState, PageHead, Skeleton, TierTag } from "../../components/ui";
import { reachOf, WiringPlate } from "../../components/WiringPlate";
import { invoke } from "../../lib/api";
import { useApp, usePlatform } from "../../lib/queries";
import { AppSurface } from "./AppSurface";

/** Using a live app. */
export const AppPage = ({ id }: { id: string }) => {
  const q = useApp(id);
  const platform = usePlatform();
  const run = useCallback((handler: string, input: unknown) => invoke(`/v1/apps/${id}/invoke`, { handler, input }), [id]);
  return (
    <QueryView query={q} skeleton={<Skeleton lines={8} label="Opening the app" />}>
      {(a) => {
        if (!a.live)
          return (
            <EmptyState
              title={`${a.name} is not live`}
              action={
                a.mine ? (
                  <Link to="/apps/$id/manage" params={{ id }} className="btn">
                    Manage versions
                  </Link>
                ) : undefined
              }
            >
              {a.status === "disabled" ? "It was switched off." : "It has no published version yet."}
            </EmptyState>
          );
        const reach = a.live.reach ?? a.live.manifest;
        return (
          <>
            <PageHead
              title={a.name}
              actions={
                a.mine ? (
                  <Link to="/apps/$id/manage" params={{ id }} className="btn">
                    Manage
                  </Link>
                ) : undefined
              }
            >
              {a.description}
            </PageHead>
            <div className="split">
              <div>
                <AppSurface ui={a.live.ui} scope={`${id}@${a.live.number}`} invoke={run} />
              </div>
              <aside className="sticky" aria-label="About this app">
                {reach && <WiringPlate name={a.name} reach={reachOf(reach, platform.data)} />}
                <div className="aside-facts">
                  <dl className="kv small">
                    <dt>Built by</dt>
                    <dd>{a.owner}</dd>
                    <dt>Version</dt>
                    <dd>{a.live.number}</dd>
                    <dt>Review</dt>
                    <dd>
                      <TierTag tier={a.live.tier} />
                    </dd>
                  </dl>
                </div>
              </aside>
            </div>
          </>
        );
      }}
    </QueryView>
  );
};
