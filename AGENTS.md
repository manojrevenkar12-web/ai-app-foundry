# Working in this repository

## Fast feedback

- `pnpm install && pnpm -r build` once; `pnpm lint` and `pnpm -r typecheck` before every commit.
- `pnpm -r --filter "./packages/*" test`: contract, sandbox and gate (seconds, no services).
- `pnpm --filter @foundry/api test`: the API, identity, lifecycle and MCP server against
  PostgreSQL 16 and Redis (`TEST_ADMIN_URL` is a superuser URL; run `scripts/bootstrap-db.sql` once).
- `pnpm --filter @foundry/console test` (components) and `... e2e` (Playwright against the
  production build with its CSP; needs the API running with `DEV_IDP=on`, see CI).
- `cd services/fault-model && uv run ruff check . && uv run pytest -q`.
- `pnpm --filter @foundry/api load` writes `reports/load/latest.json`.

## Invariants (each has a test)

- The runtime enforces the manifest on every `ctx` call with the same rules as the gate
  (`packages/gate/src/enforce.ts`); never add a capability to the runtime that the gate does not see.
- Data access is the viewer's: connectors check the viewer's groups and every query runs under
  row-level security with the viewer's countries. No service account reads on behalf of an app.
- Writes to other systems happen only through `ctx.confirm` and the person's confirmation. Models
  never get write connectors as tools.
- Approvals name the bundle hash; a changed bundle is a new version.
- Group membership that cannot be determined fails closed.
- The audit log is append-only and hash-chained; `GET /v1/audit/verify` must stay intact.
- The simulated world's truth (`build/sim/truth.json`) is
  read only by the fault model's evaluation, never by the API or the console.
- Thresholds, prices, connectors, groups and roles live in `config/`, not in code.

## Held-out sets

`heldout/<set>/cases` are written blind from `heldout/WRITING_APPS.md` by someone who has not read
the platform's code. Never change the platform to pass a set. Its first run
(`reports/heldout/<set>/first_run.json`) is never rewritten. If you study a set's failures, write
`regression` into `heldout/<set>/STATUS` and have someone who has not seen the code write a new set.
`heldout/dev-smoke` is not held out: it checks the runner itself.
