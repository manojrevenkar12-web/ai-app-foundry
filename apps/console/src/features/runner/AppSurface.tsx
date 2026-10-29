import { useCallback, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Markdown } from "../../components/Markdown";
import { api, type Confirmation, type InvokeResult } from "../../lib/api";
import type { UiSpec } from "../../lib/types";
import { ChatBlock } from "./ChatBlock";
import { type RunnerApi, RunnerContext } from "./context";
import { FormBlock } from "./FormBlock";
import { ViewBlock } from "./ViewBlock";

/** Renders an app's declared UI: its pages as tabs, its blocks from the platform's components. */
export const AppSurface = ({
  ui,
  scope,
  invoke,
}: {
  ui: UiSpec;
  scope: string;
  invoke: (handler: string, input: unknown) => Promise<InvokeResult>;
}) => {
  const [page, setPage] = useState(ui.pages[0]?.id ?? "");
  const [pending, setPending] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const resolver = useRef<((v: unknown | null) => void) | null>(null);

  const askConfirm = useCallback((c: Confirmation) => {
    setError(null);
    setPending(c);
    return new Promise<unknown | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback(
    async (decision: "confirm" | "cancel") => {
      if (!pending) return;
      setBusy(true);
      try {
        const out = await api.post<unknown>(`/v1/confirmations/${pending.id}`, { decision });
        resolver.current?.(decision === "cancel" ? null : out);
        setPending(null);
      } catch (e) {
        if (decision === "cancel") {
          resolver.current?.(null);
          setPending(null);
        } else setError(e);
      } finally {
        setBusy(false);
      }
    },
    [pending],
  );

  const runner = useMemo<RunnerApi>(() => ({ scope, invoke, askConfirm }), [scope, invoke, askConfirm]);
  const current = ui.pages.find((p) => p.id === page) ?? ui.pages[0];

  return (
    <RunnerContext.Provider value={runner}>
      {ui.pages.length > 1 && (
        <div className="tabs" role="tablist" aria-label="Pages">
          {ui.pages.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === current?.id} onClick={() => setPage(p.id)}>
              {p.title}
            </button>
          ))}
        </div>
      )}
      <div className="blocks" role={ui.pages.length > 1 ? "tabpanel" : undefined}>
        {current?.blocks.map((b, i) => {
          const key = `${current.id}-${i}`;
          if (b.type === "markdown")
            return (
              <section key={key} className="block">
                <Markdown text={b.text} />
              </section>
            );
          if (b.type === "form") return <FormBlock key={key} spec={b} />;
          if (b.type === "chat") return <ChatBlock key={key} spec={b} />;
          return <ViewBlock key={key} spec={b} />;
        })}
      </div>
      <ConfirmDialog confirmation={pending} busy={busy} error={error} onAnswer={(d) => void answer(d)} />
    </RunnerContext.Provider>
  );
};
