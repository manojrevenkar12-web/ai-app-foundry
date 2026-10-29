import { Link } from "@tanstack/react-router";
import { QueryView } from "../../components/QueryView";
import { EmptyState, PageHead, Skeleton, TierTag } from "../../components/ui";
import { short, when } from "../../lib/format";
import { useReviews } from "../../lib/queries";

export const Reviews = () => {
  const q = useReviews();
  return (
    <>
      <PageHead title="Reviews">
        Versions waiting for you. You approve the exact bundle you read; any change is a new version and a new review. You never see your
        own apps here.
      </PageHead>
      <QueryView
        query={q}
        skeleton={<Skeleton lines={5} height="var(--s-6)" label="Loading reviews" />}
        empty={
          <EmptyState title="Nothing to review">
            When a colleague submits an app that needs a second pair of eyes, it appears here.
          </EmptyState>
        }
      >
        {(items) => (
          <ul className="directory" aria-label="Waiting for review">
            {items.map((v) => (
              <li key={`${v.app_id}@${v.number}`}>
                <Link to="/reviews/$id/$n" params={{ id: v.app_id, n: String(v.number) }} className="entry">
                  <div>
                    <h2>
                      {v.name} <span className="muted">version {v.number}</span>
                    </h2>
                    <p>
                      Submitted by {v.created_by_name}, {when(v.created_at)}. Bundle {short(v.bundle_hash)}.
                    </p>
                  </div>
                  <div className="entry__meta">
                    <TierTag tier={v.tier} pending />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </>
  );
};
