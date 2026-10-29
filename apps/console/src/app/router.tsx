import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { EmptyState } from "../components/ui";
import { Build } from "../features/build/Build";
import { Catalog } from "../features/catalog/Catalog";
import { Manage } from "../features/manage/Manage";
import { Operations } from "../features/ops/Operations";
import { ReviewDetail } from "../features/review/ReviewDetail";
import { Reviews } from "../features/review/Reviews";
import { AppPage } from "../features/runner/AppPage";
import { Tokens } from "../features/tokens/Tokens";
import { Shell } from "./Shell";

const root = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <EmptyState
      title="There is no page here"
      action={
        <a href="/" className="btn">
          Go to apps
        </a>
      }
    >
      The link may be old, or the app was removed.
    </EmptyState>
  ),
});

const catalog = createRoute({ getParentRoute: () => root, path: "/", component: Catalog });
const app = createRoute({
  getParentRoute: () => root,
  path: "/apps/$id",
  component: function AppRoute() {
    const { id } = app.useParams();
    return <AppPage key={id} id={id} />;
  },
});
const manage = createRoute({
  getParentRoute: () => root,
  path: "/apps/$id/manage",
  component: function ManageRoute() {
    const { id } = manage.useParams();
    return <Manage key={id} id={id} />;
  },
});
const build = createRoute({
  getParentRoute: () => root,
  path: "/build",
  validateSearch: (s: Record<string, unknown>): { from?: string } =>
    typeof s.from === "string" && /^[a-z][a-z0-9-]{2,39}$/.test(s.from) ? { from: s.from } : {},
  component: function BuildRoute() {
    const { from } = build.useSearch();
    return <Build key={from ?? "new"} {...(from ? { from } : {})} />;
  },
});
const reviews = createRoute({ getParentRoute: () => root, path: "/reviews", component: Reviews });
const review = createRoute({
  getParentRoute: () => root,
  path: "/reviews/$id/$n",
  component: function ReviewRoute() {
    const { id, n } = review.useParams();
    return <ReviewDetail key={`${id}@${n}`} id={id} n={Number(n)} />;
  },
});
const ops = createRoute({ getParentRoute: () => root, path: "/ops", component: Operations });
const tokens = createRoute({ getParentRoute: () => root, path: "/tokens", component: Tokens });

export const routeTree = root.addChildren([catalog, app, manage, build, reviews, review, ops, tokens]);
export const createAppRouter = () => createRouter({ routeTree, defaultPreload: "intent", scrollRestoration: true });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
