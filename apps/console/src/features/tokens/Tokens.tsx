import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { QueryView } from "../../components/QueryView";
import { Button, EmptyState, ErrorState, PageHead, Skeleton, StatusTag } from "../../components/ui";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { keys, useTokens } from "../../lib/queries";

const SCOPES = [
  { id: "apps:read", label: "Read apps and the platform catalogue" },
  { id: "apps:write", label: "Check, preview and submit apps" },
  { id: "apps:invoke", label: "Run apps" },
] as const;

const mcpConfig = (token: string) =>
  JSON.stringify(
    {
      mcpServers: {
        foundry: { command: "npx", args: ["-y", "@foundry/mcp"], env: { FOUNDRY_URL: window.location.origin, FOUNDRY_TOKEN: token } },
      },
    },
    null,
    2,
  );

/** Tokens let an AI coding tool (Claude Code, Copilot, Cursor) build apps through the platform's MCP server, as you. */
export const Tokens = () => {
  const q = useTokens();
  const qc = useQueryClient();
  const id = useId();
  const [name, setName] = useState("Claude Code on my laptop");
  const [scopes, setScopes] = useState<string[]>(["apps:read", "apps:write"]);
  const [days, setDays] = useState(7);
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; token: string }>("/v1/tokens", { name, scopes, days }),
    onSuccess: (t) => {
      setIssued(t);
      setCopied(false);
      void qc.invalidateQueries({ queryKey: keys.tokens });
    },
  });
  const revoke = useMutation({
    mutationFn: (tid: string) => api.del(`/v1/tokens/${tid}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.tokens }),
  });

  const copy = async (text: string) => {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
  };

  return (
    <>
      <PageHead title="Tokens for coding tools">
        Build apps from your editor: your AI coding tool talks to the platform's MCP server with a token that acts as you, for at most 30
        days. The same checks and reviews apply.
      </PageHead>
      <div className="split">
        <section className="panel" aria-labelledby={`${id}-h`}>
          <h2 id={`${id}-h`}>New token</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="field">
              <label htmlFor={`${id}-n`}>Name</label>
              <input id={`${id}-n`} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </div>
            <fieldset className="field">
              <legend className="label">It may</legend>
              {SCOPES.map((s) => (
                <label key={s.id} className="toggle">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s.id)}
                    onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))}
                  />
                  {s.label}
                </label>
              ))}
            </fieldset>
            <div className="field">
              <label htmlFor={`${id}-d`}>Valid for (days)</label>
              <input
                id={`${id}-d`}
                className="input"
                type="number"
                min={1}
                max={30}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </div>
            <div className="block__actions">
              <button type="submit" className="btn btn--primary" disabled={create.isPending || scopes.length === 0 || !name.trim()}>
                Create token
              </button>
            </div>
            {create.isError && <ErrorState error={create.error} compact />}
          </form>
          {issued && (
            <div className="secret section" role="status">
              <strong>Copy the token now. It is not shown again.</strong>
              <code>{issued.token}</code>
              <div className="row">
                <Button small onClick={() => void copy(issued.token)}>
                  {copied ? "Copied" : "Copy token"}
                </Button>
                <Button small onClick={() => void copy(mcpConfig(issued.token))}>
                  Copy MCP configuration
                </Button>
              </div>
              <pre className="codeview">
                <code>{mcpConfig("fdy_…")}</code>
              </pre>
            </div>
          )}
        </section>
        <section aria-label="Your tokens">
          <QueryView
            query={q}
            skeleton={<Skeleton lines={4} label="Loading tokens" />}
            empty={<EmptyState title="No tokens">Create one to connect your coding tool.</EmptyState>}
          >
            {(rows) => (
              <ul className="findings">
                {rows.map((t) => {
                  const state = t.revoked_at ? "revoked" : new Date(t.expires_at) < new Date() ? "expired" : "active";
                  return (
                    <li key={t.id} className="finding">
                      <StatusTag status={state} />
                      <div className="spread">
                        <strong>{t.name}</strong>
                        {state === "active" && (
                          <Button small variant="quiet" disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)}>
                            Revoke
                          </Button>
                        )}
                      </div>
                      <p className="muted">
                        {t.scopes.join(", ")}.{" "}
                        {state === "active"
                          ? `Expires ${when(t.expires_at)}`
                          : state === "revoked"
                            ? `Revoked ${when(t.revoked_at as string)}`
                            : "Expired"}
                        {t.last_used_at ? `, last used ${when(t.last_used_at)}` : ", never used"}.
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueryView>
        </section>
      </div>
    </>
  );
};
