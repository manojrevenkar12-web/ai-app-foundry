import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useState } from "react";
import { Button, EmptyState, ErrorState, PageHead, Skeleton, StatusTag } from "../../components/ui";
import { api, invoke } from "../../lib/api";
import { useApp, usePlatform, useVersion } from "../../lib/queries";
import type { Bundle, Draft, GateReport } from "../../lib/types";
import { AppSurface } from "../runner/AppSurface";
import { Report } from "./Report";

type Part = "manifest" | "code" | "ui" | "tests";
const PARTS: Array<{ id: Part; label: string; file: string }> = [
  { id: "manifest", label: "Manifest", file: "manifest.json" },
  { id: "code", label: "Code", file: "handlers.js" },
  { id: "ui", label: "Screens", file: "ui.json" },
  { id: "tests", label: "Tests", file: "tests.json" },
];
type Texts = Record<Part, string>;

const toTexts = (b: Bundle): Texts => ({
  manifest: JSON.stringify(b.manifest, null, 2),
  code: b.code,
  ui: JSON.stringify(b.ui, null, 2),
  tests: JSON.stringify(b.tests, null, 2),
});

/** The editors' text as a bundle, or which part is not valid JSON. */
const toBundle = (t: Texts): { bundle: Bundle } | { error: string } => {
  const out: Record<string, unknown> = { code: t.code };
  for (const p of ["manifest", "ui", "tests"] as const) {
    try {
      out[p] = JSON.parse(t[p]);
    } catch (e) {
      return { error: `${PARTS.find((x) => x.id === p)?.file}: ${(e as Error).message}` };
    }
  }
  return { bundle: out as unknown as Bundle };
};

const EXAMPLES = [
  "An assistant for field technicians: given a charge point id, explain why it is faulted, using its recent errors, the fault model and the runbooks.",
  "A form that lists the charge points in a city with their status, and summarises how many are faulted.",
  "A private notebook where I keep handover notes for the next shift.",
];

interface Submitted {
  app: string;
  number: number;
  status: string;
  report: GateReport;
}

export const Build = ({ from }: { from?: string }) => {
  const id = useId();
  const [description, setDescription] = useState("");
  const [texts, setTexts] = useState<Texts | null>(null);
  const [part, setPart] = useState<Part>("manifest");
  const [report, setReport] = useState<GateReport | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [generator, setGenerator] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const platform = usePlatform();

  // starting from an existing app: its newest version
  const source = useApp(from ?? "");
  const newest = source.data?.versions?.[0]?.number ?? 0;
  const sourceVersion = useVersion(from ?? "", from ? newest : 0);
  useEffect(() => {
    if (from && sourceVersion.data && !texts) {
      setTexts(toTexts(sourceVersion.data.bundle));
      setGenerator(`version ${sourceVersion.data.number} of ${from}`);
    }
  }, [from, sourceVersion.data, texts]);

  const draft = useMutation({
    mutationFn: (d: string) => api.post<Draft>("/v1/builder/draft", { description: d }),
    onSuccess: (d) => {
      setTexts(toTexts(d.bundle));
      setReport(d.report);
      setChecked(JSON.stringify(toTexts(d.bundle)));
      setGenerator(`${d.generator}${d.attempts > 1 ? `, ${d.attempts} attempts` : ""}`);
      setSubmitted(null);
    },
  });
  const check = useMutation({
    mutationFn: (v: { bundle: Bundle; snapshot: string }) => api.post<GateReport>("/v1/check", v.bundle),
    onSuccess: (r, v) => {
      setReport(r);
      setChecked(v.snapshot);
    },
  });
  const submit = useMutation({
    mutationFn: (b: Bundle) => api.post<Submitted>("/v1/apps", { bundle: b }),
    onSuccess: setSubmitted,
  });
  const publish = useMutation({
    mutationFn: (s: Submitted) => api.post<{ live: number }>(`/v1/apps/${s.app}/versions/${s.number}/publish`),
  });

  const current = texts ? toBundle(texts) : null;
  const fresh = texts !== null && checked === JSON.stringify(texts);
  const bundle = current && "bundle" in current ? current.bundle : null;

  const runCheck = () => {
    if (!current) return;
    if ("error" in current) return setParseError(current.error);
    setParseError(null);
    check.mutate({ bundle: current.bundle, snapshot: JSON.stringify(texts) });
  };
  const preview = useCallback((handler: string, input: unknown) => invoke("/v1/preview", { bundle, handler, input }), [bundle]);

  const step = !texts ? 1 : !fresh || !report?.ok ? 2 : submitted ? 4 : 3;

  if (from && (source.isPending || sourceVersion.isPending) && !texts) return <Skeleton lines={8} label="Loading the app" />;
  if (from && (source.isError || sourceVersion.isError))
    return <ErrorState error={source.error ?? sourceVersion.error} onRetry={() => void sourceVersion.refetch()} />;

  return (
    <>
      <PageHead title={from ? `New version of ${source.data?.name ?? from}` : "Build an app"}>
        Describe what you need. The builder drafts the app as a manifest, code, screens and tests; the platform checks it, you try it on
        real data you may see, and it goes live after the review its reach needs.
      </PageHead>
      <ol className="steps" aria-label="Progress">
        {["Describe", "Check", "Try it", "Submit"].map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? "step" : undefined} data-done={step > i + 1}>
            {s}
          </li>
        ))}
      </ol>

      {!from && (
        <section className="panel">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              draft.mutate(description);
            }}
          >
            <div className="field">
              <label htmlFor={`${id}-d`}>What should the app do?</label>
              <textarea
                id={`${id}-d`}
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                minLength={10}
                maxLength={2000}
                required
                placeholder="Who uses it, what they ask, which data it needs"
              />
              <span className="help">Drafted by {platform.data?.builder ?? "the builder"}. Nothing is published until you submit it.</span>
            </div>
            <div className="suggestions section">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" onClick={() => setDescription(x)}>
                  {x}
                </button>
              ))}
            </div>
            <div className="block__actions">
              <button type="submit" className="btn btn--primary" disabled={draft.isPending || description.trim().length < 10}>
                {draft.isPending ? "Drafting…" : texts ? "Draft again" : "Draft the app"}
              </button>
              {draft.isError && <ErrorState error={draft.error} compact />}
            </div>
          </form>
        </section>
      )}

      {draft.isPending && !texts && (
        <div className="section">
          <Skeleton lines={10} label="Drafting the app" />
        </div>
      )}

      {texts && (
        <div className="split split--even section">
          <section aria-labelledby={`${id}-e`}>
            <div className="spread">
              <h2 id={`${id}-e`}>The app</h2>
              {generator && <span className="small muted">From {generator}</span>}
            </div>
            <div className="tabs" role="tablist" aria-label="Files">
              {PARTS.map((p) => (
                <button key={p.id} type="button" role="tab" aria-selected={part === p.id} onClick={() => setPart(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
            <label htmlFor={`${id}-${part}`} className="sr-only">
              {PARTS.find((p) => p.id === part)?.file}
            </label>
            <textarea
              id={`${id}-${part}`}
              className="input code"
              spellCheck={false}
              value={texts[part]}
              onChange={(e) => setTexts({ ...texts, [part]: e.target.value })}
            />
            <div className="block__actions">
              <Button variant="primary" onClick={runCheck} disabled={check.isPending}>
                {check.isPending ? "Checking…" : "Run the checks"}
              </Button>
              {!fresh && report && <span className="small muted">Changed since the last check.</span>}
            </div>
            {parseError && (
              <p role="alert" className="inline-error">
                {parseError}
              </p>
            )}
            {check.isError && <ErrorState error={check.error} compact />}
          </section>
          <section aria-label="Check results">
            {check.isPending ? (
              <Skeleton lines={8} label="Checking" />
            ) : report ? (
              <Report report={report} name={bundle?.manifest?.name ?? "App"} />
            ) : (
              <EmptyState title="Not checked yet">Run the checks to see what the app reaches and the review it needs.</EmptyState>
            )}
          </section>
        </div>
      )}

      {texts && fresh && report?.ok && bundle && (
        <section className="section" aria-labelledby={`${id}-p`}>
          <h2 id={`${id}-p`}>Try it</h2>
          <p className="lead">
            The preview runs as you, against data you may see, with its own storage and budget. Writes are not possible in a preview.
          </p>
          <AppSurface ui={bundle.ui} scope={`preview:${report.hash}`} invoke={preview} />
        </section>
      )}

      {texts && fresh && report?.ok && bundle && (
        <section className="section panel" aria-labelledby={`${id}-s`}>
          <h2 id={`${id}-s`}>Submit</h2>
          {!submitted ? (
            <>
              <p className="lead">
                {report.tier?.tier === 0
                  ? "This app needs no reviewer. After you submit it you can publish it straight away."
                  : `This app needs ${report.tier?.approvals.role === "Foundry.Reviewer" ? "a platform reviewer" : "a second builder"} to approve exactly this bundle.`}
              </p>
              <div className="row">
                <Button variant="primary" onClick={() => submit.mutate(bundle)} disabled={submit.isPending}>
                  {submit.isPending ? "Submitting…" : "Submit version"}
                </Button>
                {submit.isError && <ErrorState error={submit.error} compact />}
              </div>
            </>
          ) : (
            <div className="row">
              <span>
                Version {submitted.number} of {submitted.app} is <StatusTag status={submitted.status} />
              </span>
              {submitted.status === "approved" && !publish.isSuccess && (
                <Button variant="primary" onClick={() => publish.mutate(submitted)} disabled={publish.isPending}>
                  {publish.isPending ? "Publishing…" : "Publish"}
                </Button>
              )}
              {publish.isSuccess && (
                <Link to="/apps/$id" params={{ id: submitted.app }} className="btn btn--primary">
                  Open the app
                </Link>
              )}
              <Link to="/apps/$id/manage" params={{ id: submitted.app }} className="btn">
                Manage versions
              </Link>
              {publish.isError && <ErrorState error={publish.error} compact />}
            </div>
          )}
        </section>
      )}
    </>
  );
};
