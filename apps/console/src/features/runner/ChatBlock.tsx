import { motion } from "motion/react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Markdown } from "../../components/Markdown";
import { Button, ErrorState } from "../../components/ui";
import type { Block } from "../../lib/types";
import { reveal } from "../../theme/motion";
import { useRunner } from "./context";

type ChatSpec = Extract<Block, { type: "chat" }>;
interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
  streaming?: boolean;
}

/** The handler's answer: a string, or { reply, sources }. */
const answerOf = (v: unknown): { text: string; sources: string[] } => {
  if (typeof v === "string") return { text: v, sources: [] };
  const o = (v ?? {}) as { reply?: unknown; text?: unknown; sources?: unknown };
  const text = typeof o.reply === "string" ? o.reply : typeof o.text === "string" ? o.text : JSON.stringify(v, null, 2);
  const sources = Array.isArray(o.sources) ? [...new Set(o.sources.filter((s): s is string => typeof s === "string"))] : [];
  return { text, sources };
};

const HISTORY = 10;

export const ChatBlock = ({ spec }: { spec: ChatSpec }) => {
  const runner = useRunner();
  const id = useId();
  const [log, setLog] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ error: unknown; message: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the log changes
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [log]);

  const send = async (message: string) => {
    const text = message.trim();
    if (!text || busy) return;
    const history = log
      .filter((m) => !m.streaming)
      .slice(-HISTORY)
      .map(({ role, content }) => ({ role, content }));
    setLog((l) => [...l, { role: "user", content: text }]);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const r = await runner.invoke(spec.handler, { message: text, history });
      if (r.kind === "stream") {
        setLog((l) => [...l, { role: "assistant", content: "", streaming: true }]);
        let acc = "";
        for await (const t of r.stream) {
          acc += t;
          const now = acc;
          setLog((l) => [...l.slice(0, -1), { role: "assistant", content: now, streaming: true }]);
        }
        setLog((l) => [...l.slice(0, -1), { role: "assistant", content: acc }]);
      } else if (r.kind === "confirm") {
        const outcome = await runner.askConfirm(r.confirmation);
        setLog((l) => [
          ...l,
          { role: "assistant", content: outcome === null ? "Cancelled. Nothing was changed." : `Done: ${r.confirmation.summary}.` },
        ]);
      } else {
        const a = answerOf(r.value);
        setLog((l) => [...l, { role: "assistant", content: a.text, sources: a.sources }]);
      }
    } catch (e) {
      setLog((l) => (l[l.length - 1]?.streaming ? l.slice(0, -1) : l));
      setError({ error: e, message: text });
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <section className="block chat" aria-label="Conversation">
      {spec.intro && log.length === 0 && <Markdown text={spec.intro} />}
      {log.length > 0 && (
        <div className="chat__log" role="log" aria-live="polite" aria-busy={busy}>
          {log.map((m, i) => (
            <motion.div
              // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows
              key={i}
              className={`msg msg--${m.role}`}
              variants={reveal}
              initial="hidden"
              animate="shown"
            >
              <span className="msg__who">{m.role === "user" ? "You" : "Answer"}</span>
              {m.role === "assistant" ? (
                <div>
                  <Markdown text={m.content} />
                  {m.streaming && <span className="caret" aria-hidden="true" />}
                </div>
              ) : (
                <p>{m.content}</p>
              )}
              {m.sources && m.sources.length > 0 && (
                <ul className="msg__sources" aria-label="Sources">
                  {m.sources.map((s) => (
                    <li key={s} className="tag tag--neutral">
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </motion.div>
          ))}
          {busy && log[log.length - 1]?.role === "user" && (
            <div className="msg msg--assistant">
              <span className="msg__who">Answer</span>
              <span className="muted small">Reading the data you can see…</span>
            </div>
          )}
          <div ref={end} />
        </div>
      )}
      {error && (
        <div className="row">
          <ErrorState error={error.error} compact />
          <Button small onClick={() => void send(error.message)}>
            Send again
          </Button>
        </div>
      )}
      {log.length === 0 && spec.suggestions.length > 0 && (
        <div className="suggestions">
          {spec.suggestions.map((s) => (
            <button key={s} type="button" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form className="chat__form" onSubmit={onSubmit}>
        <label htmlFor={`${id}-m`} className="sr-only">
          Message
        </label>
        <textarea
          id={`${id}-m`}
          className="input"
          rows={1}
          value={draft}
          placeholder={spec.placeholder ?? "Ask a question"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          maxLength={2000}
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
};
