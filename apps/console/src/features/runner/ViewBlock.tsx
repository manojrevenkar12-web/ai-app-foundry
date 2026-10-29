import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Button, ErrorState, Skeleton } from "../../components/ui";
import type { Block } from "../../lib/types";
import { useRunner } from "./context";
import { ResultViews } from "./ResultViews";

type ViewSpec = Extract<Block, { type: "view" }>;

/** A handler that runs when the page opens, with no input. */
export const ViewBlock = ({ spec }: { spec: ViewSpec }) => {
  const runner = useRunner();
  const id = useId();
  const q = useQuery({
    queryKey: ["view", runner.scope, spec.handler],
    queryFn: async () => {
      const r = await runner.invoke(spec.handler, {});
      if (r.kind !== "value") throw new Error("a view handler must return a value");
      return r.value;
    },
    retry: false,
  });
  return (
    <section className="block" aria-labelledby={`${id}-h`}>
      <div className="spread">
        <h2 id={`${id}-h`}>{spec.title ?? "Overview"}</h2>
        <Button small variant="quiet" onClick={() => void q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {q.isPending ? (
        <Skeleton lines={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <ResultViews views={spec.result} value={q.data} />
      )}
    </section>
  );
};
