import { Mark } from "../../app/Mark";
import { Skeleton } from "../../components/ui";
import { usePersonas } from "../../lib/queries";

const loginUrl = (hint?: string) => {
  const q = new URLSearchParams({ returnTo: window.location.pathname + window.location.search });
  if (hint) q.set("login_hint", hint);
  return `/auth/login?${q}`;
};

/** Sign in with Microsoft Entra ID. In development the identity provider is simulated, with people to sign in as. */
export const SignIn = () => {
  const personas = usePersonas();
  return (
    <main className="signin">
      <div className="signin__box">
        <h1>
          <Mark /> Foundry
        </h1>
        <p>EDRI's platform for AI apps. Sign in with your E.ON account; apps you open act as you and see only what you may see.</p>
        {personas.isError && (
          <p className="row section">
            <a className="btn btn--primary" href={loginUrl()}>
              Sign in with Microsoft
            </a>
          </p>
        )}
        {personas.isPending ? (
          <div className="personas">
            <Skeleton lines={3} label="Loading test accounts" />
          </div>
        ) : personas.data && personas.data.length > 0 ? (
          <>
            <p className="small muted">This is a development system. Sign in as one of the test people:</p>
            <ul className="personas">
              {personas.data.map((p) => (
                <li key={p.key}>
                  <a href={loginUrl(p.key)}>
                    <strong>{p.name}</strong>
                    <span className="muted small">{p.title}</span>
                    <span className="roles">
                      {p.roles.map((r) => (
                        <span key={r} className="tag">
                          {r.replace("Foundry.", "")}
                        </span>
                      ))}
                      {p.groups.map((g) => (
                        <span key={g} className="tag tag--neutral">
                          {g}
                        </span>
                      ))}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </main>
  );
};
