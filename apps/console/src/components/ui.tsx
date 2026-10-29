import type { ComponentProps, ReactNode } from "react";
import { ApiError } from "../lib/api";

type Variant = "primary" | "phase" | "quiet" | "default";
export const Button = ({
  variant = "default",
  small,
  className,
  ...rest
}: ComponentProps<"button"> & { variant?: Variant; small?: boolean }) => (
  <button
    type="button"
    className={["btn", variant !== "default" && `btn--${variant}`, small && "btn--small", className].filter(Boolean).join(" ")}
    {...rest}
  />
);

/** The last placeholder line is shorter, like the end of a paragraph. */
const LAST_LINE = "62%";

/** Placeholder lines while something loads. Styles are set through the CSSOM, which the CSP allows. */
export const Skeleton = ({ lines = 3, height = "var(--s-4)", label = "Loading" }: { lines?: number; height?: string; label?: string }) => (
  <div role="status" aria-label={label}>
    {Array.from({ length: lines }, (_, i) => (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines have no identity
        key={i}
        className="skeleton"
        style={{ height, width: i === lines - 1 && lines > 1 ? LAST_LINE : "100%", marginTop: i ? "var(--s-2)" : 0 }}
      />
    ))}
  </div>
);

const explain = (e: unknown): { title: string; detail: string; code?: string } => {
  if (e instanceof ApiError) {
    if (e.status === 0 || e.code === "NETWORK") return { title: "The platform cannot be reached", detail: e.message };
    if (e.status === 403) return { title: "You do not have access to this", detail: e.message, code: e.code };
    if (e.status === 404) return { title: "Not found", detail: e.message, code: e.code };
    if (e.status === 429) return { title: "Too many requests", detail: `${e.message}. Wait a minute and try again.`, code: e.code };
    return { title: "That did not work", detail: e.message, code: e.code };
  }
  return { title: "That did not work", detail: e instanceof Error ? e.message : String(e) };
};

export const ErrorState = ({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) => {
  const x = explain(error);
  if (compact)
    return (
      <p role="alert" className="inline-error">
        {x.detail} {x.code && <code>{x.code}</code>}
      </p>
    );
  return (
    <div role="alert" className="state state--error">
      <h3>{x.title}</h3>
      <p>
        {x.detail} {x.code && <code>{x.code}</code>}
      </p>
      {onRetry && (
        <Button small onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
};

export const EmptyState = ({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="state">
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action}
  </div>
);

const TIER_TEXT = {
  0: { label: "Checked automatically", title: "Tier 0: passed the automatic checks; no reviewer needed", cls: "tag--ok" },
  1: { label: "Peer reviewed", title: "Tier 1: approved by a second builder", cls: "tag--neutral" },
  2: { label: "Platform reviewed", title: "Tier 2: approved by a platform reviewer", cls: "tag--phase" },
} as const;
const PENDING = {
  0: "No reviewer needed",
  1: "Needs a second builder",
  2: "Needs a platform reviewer",
} as const;
/** The review a version had (decided) or needs (pending). */
export const TierTag = ({ tier, pending }: { tier: 0 | 1 | 2 | null | undefined; pending?: boolean }) => {
  if (tier === null || tier === undefined) return null;
  const t = TIER_TEXT[tier];
  return (
    <span className={`tag ${pending ? "" : t.cls}`} title={`Tier ${tier}`}>
      {pending ? PENDING[tier] : t.label}
    </span>
  );
};

const STATUS_CLASS: Record<string, string> = {
  live: "tag--ok",
  approved: "tag--ok",
  in_review: "tag--warn",
  blocked: "tag--fault",
  rejected: "tag--fault",
  disabled: "tag--fault",
  draft: "",
  superseded: "",
  withdrawn: "",
  Available: "tag--ok",
  Charging: "tag--neutral",
  Faulted: "tag--fault",
  Unavailable: "tag--warn",
  open: "tag--warn",
  closed: "",
  active: "tag--ok",
  revoked: "",
  expired: "",
};
export const StatusTag = ({ status }: { status: string }) => (
  <span className={`tag ${STATUS_CLASS[status] ?? ""}`}>{status.replace("_", " ")}</span>
);

export const PageHead = ({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) => (
  <header className="head">
    <div>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
    {actions && <div className="head__actions">{actions}</div>}
  </header>
);
