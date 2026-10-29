import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef } from "react";
import type { Confirmation } from "../lib/api";
import { DURATION, EASE } from "../theme/motion";
import { Button, ErrorState } from "./ui";

/**
 * An app asked to change something in another system. Nothing happens until the person using it
 * closes the breaker. The dialog shows exactly what will be sent.
 */
export const ConfirmDialog = ({
  confirmation,
  busy,
  error,
  onAnswer,
}: {
  confirmation: Confirmation | null;
  busy: boolean;
  error: unknown;
  onAnswer: (decision: "confirm" | "cancel") => void;
}) => {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const before = useRef<Element | null>(null);

  useEffect(() => {
    if (!confirmation) return;
    before.current = document.activeElement;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onAnswer("cancel");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      (before.current as HTMLElement | null)?.focus?.();
    };
  }, [confirmation, busy, onAnswer]);

  return (
    <AnimatePresence>
      {confirmation && (
        <motion.div
          className="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: DURATION.quick }}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${id}-t`}
            aria-describedby={`${id}-d`}
            className="dialog"
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: DURATION.base, ease: EASE }}
          >
            <h2 id={`${id}-t`}>{confirmation.summary}</h2>
            <div className="breaker-row" id={`${id}-d`}>
              <svg viewBox="0 0 44 24" aria-hidden="true">
                <path className="wire wire--phase" d="M2 16 H14 M30 16 H42" fill="none" stroke="currentColor" strokeWidth="2" />
                <motion.line
                  x1="15"
                  y1="16"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  initial={false}
                  animate={busy ? { x2: 29, y2: 16 } : { x2: 28, y2: 4 }}
                  transition={{ duration: DURATION.base, ease: EASE }}
                />
              </svg>
              Nothing changes in “{confirmation.title}” until you confirm.
            </div>
            <dl>
              <dt>System</dt>
              <dd>{confirmation.title}</dd>
              {Object.entries(confirmation.args).map(([k, v]) => (
                <div key={k} className="dialog__arg">
                  <dt>{k}</dt>
                  <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                </div>
              ))}
              <dt>Expires</dt>
              <dd>{new Date(confirmation.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</dd>
            </dl>
            {error ? <ErrorState error={error} compact /> : null}
            <div className="dialog__actions">
              <Button ref={cancelRef} onClick={() => onAnswer("cancel")} disabled={busy}>
                Cancel
              </Button>
              <Button variant="phase" onClick={() => onAnswer("confirm")} disabled={busy}>
                {busy ? "Sending…" : "Confirm and send"}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
