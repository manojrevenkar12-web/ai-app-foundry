import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { QueryView } from "../../components/QueryView";
import { Button, ErrorState, PageHead, Skeleton, StatusTag, TierTag } from "../../components/ui";
import { reachOf } from "../../components/WiringPlate";
import { api } from "../../lib/api";
import { short } from "../../lib/format";
import { keys, usePlatform, useVersion } from "../../lib/queries";
import { Findings, Report } from "../build/Report";

const CodeView = ({ code, hits, focus }: { code: string; hits: Set<number>; focus: number | null }) => (
  <pre className="codeview" data-file="handlers.js">
    <code>
      {code.split("\n").map((l, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
          key={i}
          id={`line-${i + 1}`}
          className={`ln${hits.has(i + 1) ? " ln--hit" : ""}`}
          aria-current={focus === i + 1 ? "true" : undefined}
        >
          {l || " "}
        </span>
      ))}
    </code>
  </pre>
);

export const ReviewDetail = ({ id, n }: { id: string; n: number }) => {
  const q = useVersion(id, n);
  const platform = usePlatform();
  const qc = useQueryClient();
  const nav = useNavigate();
  const fid = useId();
  const [comment, setComment] = useState("");
  const [focus, setFocus] = useState<number | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const decide = useMutation({
    mutationFn: (v: { decision: "approve" | "reject"; hash: string }) =>
      api.post<{ status: string }>(`/v1/apps/${id}/versions/${n}/decision`, { ...v, comment }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.reviews });
      void nav({ to: "/reviews" });
    },
  });

  const goLine = (line: number) => {
    setFocus(line);
    codeRef.current?.querySelector(`#line-${line}`)?.scrollIntoView?.({ block: "center" });
  };

  return (
    <QueryView query={q} skeleton={<Skeleton lines={10} label="Loading the version" />}>
      {(v) => {
        const hits = new Set(v.gate.findings.flatMap((f) => (f.line ? [f.line] : [])));
        const previous = v.liveBundle ? reachOf(v.liveBundle.manifest, platform.data) : null;
        return (
          <>
            <PageHead
              title={`${v.bundle.manifest.name}, version ${v.number}`}
              actions={
                <Link to="/reviews" className="btn btn--quiet">
                  Back to reviews
                </Link>
              }
            >
              {v.bundle.manifest.description}
            </PageHead>
            <div className="row section">
              <StatusTag status={v.status} />
              <TierTag tier={v.tier} pending={!["approved", "live", "superseded"].includes(v.status)} />
              <span className="small muted">
                Submitted by {v.created_by_name}. Bundle {short(v.bundle_hash)}.
                {previous ? " The plate marks what is new since the live version." : " There is no live version yet."}
              </span>
            </div>
            <div className="split split--even section">
              <section aria-label="Checks">
                <Report report={v.gate} name={v.bundle.manifest.name} previous={previous} />
              </section>
              <section aria-label="Code">
                <h2 className="small">handlers.js</h2>
                <Findings findings={v.gate.findings.filter((f) => f.line)} onLine={goLine} />
                <div ref={codeRef} className="section">
                  <CodeView code={v.bundle.code} hits={hits} focus={focus} />
                </div>
                <details className="section">
                  <summary>Manifest</summary>
                  <pre className="codeview">
                    <code>{JSON.stringify(v.bundle.manifest, null, 2)}</code>
                  </pre>
                </details>
              </section>
            </div>
            {v.status === "in_review" && (
              <section className="section panel" aria-labelledby={`${fid}-h`}>
                <h2 id={`${fid}-h`}>Your decision</h2>
                <p className="lead">
                  You are approving bundle {short(v.bundle_hash)}. If the author changes anything, it comes back as a new version.
                </p>
                <div className="field">
                  <label htmlFor={`${fid}-c`}>Comment for the author</label>
                  <textarea
                    id={`${fid}-c`}
                    className="input"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    maxLength={2000}
                  />
                </div>
                <div className="block__actions">
                  <Button
                    variant="primary"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ decision: "approve", hash: v.bundle_hash })}
                  >
                    Approve this version
                  </Button>
                  <Button
                    disabled={decide.isPending || comment.trim().length === 0}
                    onClick={() => decide.mutate({ decision: "reject", hash: v.bundle_hash })}
                  >
                    Reject
                  </Button>
                  {comment.trim().length === 0 && <span className="small muted">Rejecting needs a comment.</span>}
                </div>
                {decide.isError && <ErrorState error={decide.error} compact />}
              </section>
            )}
          </>
        );
      }}
    </QueryView>
  );
};
