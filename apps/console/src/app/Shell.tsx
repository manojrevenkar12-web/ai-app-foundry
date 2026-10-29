import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { Button, ErrorState, Skeleton } from "../components/ui";
import { SignIn } from "../features/session/SignIn";
import { ApiError, api } from "../lib/api";
import { useMe } from "../lib/queries";
import type { Me } from "../lib/types";
import { Mark } from "./Mark";

const can = (me: Me, ...roles: string[]) => roles.some((r) => me.roles.includes(r));

export const Shell = () => {
  const me = useMe();
  const qc = useQueryClient();
  if (me.isPending)
    return (
      <div className="shell">
        <header className="bar">
          <span className="wordmark">
            <Mark /> Foundry
          </span>
        </header>
        <main className="main">
          <Skeleton lines={5} label="Signing in" />
        </main>
      </div>
    );
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) return <SignIn />;
    return (
      <main className="main">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </main>
    );
  }
  const m = me.data;
  const signOut = async () => {
    await api.post("/auth/logout").catch(() => undefined);
    qc.clear();
    window.location.assign("/");
  };
  return (
    <div className="shell">
      <a href="#main" className="sr-only">
        Skip to content
      </a>
      <header className="bar">
        <Link to="/" className="wordmark">
          <Mark /> Foundry
        </Link>
        <nav className="nav" aria-label="Main">
          <Link to="/" activeOptions={{ exact: true }}>
            Apps
          </Link>
          {can(m, "Foundry.Builder") && <Link to="/build">Build</Link>}
          {can(m, "Foundry.Builder", "Foundry.Reviewer") && <Link to="/reviews">Reviews</Link>}
          {can(m, "Foundry.Reviewer", "Foundry.Admin") && <Link to="/ops">Operations</Link>}
          {can(m, "Foundry.Builder") && <Link to="/tokens">Tokens</Link>}
        </nav>
        <div className="bar__me">
          <span>
            <strong>{m.name}</strong>
            {!m.groupsKnown && (
              <span className="tag tag--warn" title="Your group membership could not be read; group-limited data is refused until it can.">
                groups unconfirmed
              </span>
            )}
          </span>
          <Button small variant="quiet" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="main" id="main">
        <Outlet />
      </main>
    </div>
  );
};
