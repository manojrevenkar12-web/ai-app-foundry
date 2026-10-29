import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useId, useState } from "react";
import { ErrorState, Skeleton } from "../../components/ui";
import type { Block } from "../../lib/types";
import { reveal } from "../../theme/motion";
import { useRunner } from "./context";
import { ResultViews } from "./ResultViews";

type FormSpec = Extract<Block, { type: "form" }>;
type Value = string | boolean;

const initial = (f: FormSpec["fields"][number]): Value =>
  f.kind === "toggle" ? false : f.kind === "select" && f.required ? (f.options?.[0]?.value ?? "") : "";

const toInput = (spec: FormSpec, v: Record<string, Value>) =>
  Object.fromEntries(
    spec.fields
      .filter((f) => v[f.name] !== "" || f.kind === "toggle")
      .map((f) => [f.name, f.kind === "number" ? Number(v[f.name]) : v[f.name]]),
  );

export const FormBlock = ({ spec }: { spec: FormSpec }) => {
  const runner = useRunner();
  const qc = useQueryClient();
  const id = useId();
  const [values, setValues] = useState<Record<string, Value>>(() => Object.fromEntries(spec.fields.map((f) => [f.name, initial(f)])));
  const [state, setState] = useState<{
    status: "idle" | "running" | "done" | "error" | "cancelled";
    /** value: the handler's result; text: a streamed answer; confirmed: a write the person confirmed */
    kind?: "value" | "text" | "confirmed";
    value?: unknown;
    error?: unknown;
  }>({ status: "idle" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ status: "running" });
    try {
      const r = await runner.invoke(spec.handler, toInput(spec, values));
      if (r.kind === "confirm") {
        const outcome = await runner.askConfirm(r.confirmation);
        setState(
          outcome === null
            ? { status: "cancelled" }
            : { status: "done", kind: "confirmed", value: { text: `Done: ${r.confirmation.summary}.` } },
        );
      } else if (r.kind === "stream") {
        let text = "";
        for await (const t of r.stream) {
          text += t;
          setState({ status: "running", kind: "text", value: { text } });
        }
        setState({ status: "done", kind: "text", value: { text } });
      } else setState({ status: "done", kind: "value", value: r.value });
      void qc.invalidateQueries({ queryKey: ["view", runner.scope] });
    } catch (error) {
      setState({ status: "error", error });
    }
  };

  const set = (name: string, v: Value) => setValues((s) => ({ ...s, [name]: v }));
  const views = state.kind === "value" ? spec.result : [{ type: "markdown" as const, path: "text" }];

  return (
    <section className="block" aria-labelledby={spec.title ? `${id}-h` : undefined}>
      {spec.title && <h2 id={`${id}-h`}>{spec.title}</h2>}
      <form onSubmit={submit} noValidate={false}>
        {spec.fields.map((f) => {
          const fid = `${id}-${f.name}`;
          const help = f.help ? `${fid}-help` : undefined;
          const common = { id: fid, name: f.name, required: f.required, "aria-describedby": help };
          return (
            <div key={f.name} className="field">
              {f.kind === "toggle" ? (
                <label className="toggle" htmlFor={fid}>
                  <input type="checkbox" {...common} checked={values[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} />
                  {f.label}
                </label>
              ) : (
                <label htmlFor={fid}>{f.label}</label>
              )}
              {f.kind === "textarea" && (
                <textarea className="input" {...common} value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)} />
              )}
              {f.kind === "select" && (
                <select className="input" {...common} value={String(values[f.name])} onChange={(e) => set(f.name, e.target.value)}>
                  {!f.required && <option value="">Any</option>}
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              {(f.kind === "text" || f.kind === "number" || f.kind === "date") && (
                <input
                  className="input"
                  type={f.kind}
                  {...common}
                  value={String(values[f.name])}
                  onChange={(e) => set(f.name, e.target.value)}
                  {...(f.kind === "number" ? { inputMode: "decimal" as const } : {})}
                />
              )}
              {f.help && (
                <span className="help" id={help}>
                  {f.help}
                </span>
              )}
            </div>
          );
        })}
        <div className="block__actions">
          <button type="submit" className="btn btn--primary" disabled={state.status === "running"}>
            {state.status === "running" ? "Working…" : spec.submitLabel}
          </button>
          {state.status === "cancelled" && <span className="muted small">Cancelled. Nothing was changed.</span>}
        </div>
      </form>
      <div aria-live="polite">
        {state.status === "running" && !state.value && (
          <div className="results">
            <Skeleton lines={3} label="Running" />
          </div>
        )}
        {state.status === "error" && (
          <div className="results">
            <ErrorState error={state.error} compact />
          </div>
        )}
        <AnimatePresence>
          {state.value !== undefined && (
            <motion.div key="r" variants={reveal} initial="hidden" animate="shown">
              <ResultViews views={views} value={state.value} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
};
