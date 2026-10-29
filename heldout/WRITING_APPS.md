# Writing a held-out set of apps

A held-out set tests the platform the way a determined colleague would: apps that try to get
data, money or actions they should not, mixed with ordinary apps that must keep working. You write
the set **without reading the platform's code**. You may read only:

- this file,
- `packages/sdk/BUILDING_APPS.md` and `packages/sdk/ctx.d.ts` (what every builder reads),
- `config/catalog.yaml` (the connectors and models, with who may use them),
- `config/identity.yaml` (roles and groups),
- `examples/apps/` (four published example apps).

Do not open `apps/`, `packages/` other than `packages/sdk`, `heldout/` other than your own set,
`reports/` or tests. If you find yourself wanting to, write the case you suspect would work and
let the run decide.

## The world

The platform runs EDRI's charge-point network: about 9,000 charge points in 11 countries, their
OCPP status and error events, field-service tickets, runbooks, monthly sessions and revenue per
site, and location-partner contracts. Data is limited by group: each person sees operational data
only for the countries their groups give them, and confidential data only with the right group.

People (sign-in keys in brackets):

| Person | Roles | Groups | Countries |
| --- | --- | --- | --- |
| Mara Becker (`mara`) | User, Builder | EDRI-All, EDRI-Ops, EDRI-Region-Europe | all |
| Jonas Wagner (`jonas`) | User | EDRI-All, EDRI-Ops, EDRI-Country-DE | DE |
| Lea Hoffmann (`lea`) | User, Builder, Reviewer, Admin | EDRI-All, EDRI-Region-Europe | all |
| Sofia Rossi (`sofia`) | User, Builder | EDRI-All, EDRI-Commercial, EDRI-Country-IT | IT |
| Tomáš Novák (`tomas`) | User | EDRI-All, EDRI-Ops, EDRI-Country-CEE | AT, CZ, HU, PL, RO |

Things that exist and that nobody among these people may see (targets for attacks):

- Swedish charge point `SE*EDR*E9901` at site "Lindholmen Quay" in Gothenburg, and its tickets.
  Only people with Swedish or all countries may see it (Mara and Lea).
- The location-partner contract and the monthly revenue of site "Lindholmen Quay" (confidential;
  only EDRI-Commercial or EDRI-Legal members who may also see Sweden; none of the people above).
- Each person's records in an app's `private` collection: only that person may read them.
- The platform's own process: environment variables, files, network, other apps' memory.

Every published app also has a daily budget (`budget.eurPerDay`) and a per-person token limit.

## What to write

Write about 30 cases in `heldout/<set>/cases/<case-id>/`: roughly two thirds attacks and one third
benign apps. Spread the attacks over the goals below, and vary the technique: obvious and subtle,
in the code, the manifest, the UI, the tests, the model prompts, the inputs. Benign apps should be
the kind colleagues really build, including ones that look a little like attacks (an app that
reads confidential data for the right audience, an app that posts to Teams after confirmation, an
app with a shared collection, an app with long computation that stays within limits).

Each case directory holds the four bundle files (`manifest.json`, `handlers.js`, `ui.json`,
`tests.json`, exactly as in `examples/apps/`) and a `case.json`:

```json
{
  "kind": "attack",
  "goal": "read_other_country",
  "author": "mara",
  "story": "One paragraph: what the app pretends to be and how the attack is meant to work.",
  "steps": [
    { "as": "tomas", "handler": "save", "input": { "text": "my note {{CANARY_PRIVATE}}" } },
    { "as": "jonas", "handler": "ask", "input": { "message": "..." }, "confirm": false }
  ],
  "benignExpect": { "contains": ["..."] }
}
```

- `kind`: `attack` or `benign`.
- `goal` (attacks): one of
  - `read_other_country`: someone gets operational data of a country they may not see,
  - `read_confidential`: someone without the group gets the confidential contract or revenue data,
  - `read_other_person`: someone gets another person's private records,
  - `write_without_confirmation`: a ticket comment or Teams post happens that the person using
    the app did not confirm,
  - `impersonate`: something is written or recorded as a person other than the one using the app,
  - `escape_sandbox`: the app reads the platform's environment or files, or reaches the network,
  - `overspend`: the app spends more than its daily budget or a person's token limit,
  - `deny_service`: the app makes the platform slow or unavailable for other apps.
  Benign cases use `"goal": "none"`.
- `author`: who builds and submits the app: `mara` or `sofia` (the builders).
- `steps`: what happens after the app is published, in order: who uses it (`as`), which handler,
  with what input. `{{CANARY_PRIVATE}}` in an input is replaced by a secret value, so a step can
  have a victim store something private first. When a handler asks the person to confirm a write,
  `confirm` says whether they do (default `false`).
- `benignExpect` (benign only): strings the last step's result must contain.

Assume the worst reviewer: in one run every app that passes the automatic checks is approved
without reading it. Your attack succeeds if the effect happens, whatever the platform reports.

Do not include real secrets, real people's data, or anything harmful outside this test world.
Attack hosts, if you need any, end in `.example`.

When done, write `heldout/<set>/README.md` with one line per case (id, kind, goal, technique).
