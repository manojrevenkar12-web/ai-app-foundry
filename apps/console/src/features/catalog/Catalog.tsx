import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { QueryView } from "../../components/QueryView";
import { EmptyState, PageHead, Skeleton, StatusTag, TierTag } from "../../components/ui";
import { useCatalog, useMe } from "../../lib/queries";
import type { Audience, CatalogItem } from "../../lib/types";
import { list, reveal } from "../../theme/motion";

const audience = (a: Audience | null) =>
  !a ? "" : a.kind === "owner" ? "Only you" : a.kind === "company" ? "Everyone at EDRI" : `Shared with ${a.groups.join(", ")}`;

const Entry = ({ app }: { app: CatalogItem }) => (
  <motion.li variants={reveal}>
    <Link to={app.status === "live" ? "/apps/$id" : "/apps/$id/manage"} params={{ id: app.id }} className="entry">
      <div>
        <h2>{app.name}</h2>
        <p>{app.description}</p>
      </div>
      <div className="entry__meta">
        {app.status !== "live" && <StatusTag status={app.status} />}
        <TierTag tier={app.tier} />
        <span>{app.mine ? "Yours" : `By ${app.owner}`}</span>
        {app.audience && <span>{audience(app.audience)}</span>}
      </div>
    </Link>
  </motion.li>
);

export const Catalog = () => {
  const q = useCatalog();
  const me = useMe();
  const builder = me.data?.roles.includes("Foundry.Builder");
  return (
    <>
      <PageHead
        title="Apps"
        actions={
          builder ? (
            <Link to="/build" className="btn btn--primary">
              Build an app
            </Link>
          ) : undefined
        }
      >
        Apps colleagues built on the platform. Each one runs as you: it reads only the data you may read and changes nothing without asking.
      </PageHead>
      <QueryView
        query={q}
        skeleton={<Skeleton lines={6} height="var(--s-7)" label="Loading apps" />}
        empty={
          <EmptyState
            title="No apps shared with you yet"
            action={
              builder ? (
                <Link to="/build" className="btn btn--primary">
                  Build the first one
                </Link>
              ) : undefined
            }
          >
            {builder
              ? "Describe what you need and the builder drafts an app you can check, try and publish."
              : "When colleagues share an app with your team it appears here."}
          </EmptyState>
        }
      >
        {(apps) => {
          const mine = apps.filter((a) => a.mine);
          const shared = apps.filter((a) => !a.mine);
          return (
            <>
              {shared.length > 0 && (
                <motion.ul className="directory" variants={list} initial="hidden" animate="shown" aria-label="Apps shared with you">
                  {shared.map((a) => (
                    <Entry key={a.id} app={a} />
                  ))}
                </motion.ul>
              )}
              {mine.length > 0 && (
                <section className="section">
                  <h2>Your apps</h2>
                  <motion.ul className="directory" variants={list} initial="hidden" animate="shown" aria-label="Your apps">
                    {mine.map((a) => (
                      <Entry key={a.id} app={a} />
                    ))}
                  </motion.ul>
                </section>
              )}
            </>
          );
        }}
      </QueryView>
    </>
  );
};
