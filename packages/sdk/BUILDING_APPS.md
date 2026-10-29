# Building an app on the platform

An app is four files. The platform hosts it, signs people in, checks it, and runs it for the
people it is shared with. You never handle logins, secrets, servers or databases.

| File | What it is |
|---|---|
| `manifest.json` | Everything the app may do: who can open it, its handlers, models, connectors, data collections and daily budget |
| `handlers.js` | Named exported functions `(input, ctx) => result`, run in a sandbox |
| `ui.json` | Pages made of blocks: markdown, forms, chats and views of results |
| `tests.json` | Example inputs and what the results must contain |

## Rules that are checked, not suggested

1. **Declare everything.** A connector, model alias or collection the code uses must be in the
   manifest. The publish gate reads the code; the runtime refuses anything undeclared anyway.
2. **No modules, no network, no secrets.** `import` is refused. There is no `fetch`, no timers,
   no file system. Credentials are found and blocked by the gate.
3. **Writes need the viewer.** A connector that changes data (`access: write`) can only be used by
   returning `ctx.confirm({ connector, args, summary })`. The viewer sees the summary and decides.
   A model is never given a write connector as a tool.
4. **Data stays at its level.** Data from a confidential connector cannot be stored in a
   collection classified lower. Shared collections are visible to everyone who can open the app.
5. **The UI is data.** Blocks call handlers that exist, with the fields the handler declares.
   Markdown cannot contain HTML or images.
6. **Limits per invocation:** 250 ms of CPU, 32 MiB of memory, 30 s in total, 64 platform calls,
   1 MB of result.

## The viewer, not the app

Connectors run with the identity of the person using the app. If a person may not read revenue
figures, an app cannot show them revenue figures, whatever the app's code does. Design for the
`FORBIDDEN_FOR_VIEWER` error: catch it and say what the person can do instead.

## Review

The gate gives every version a tier:

- **Tier 0** (publishes after the checks): internal data only, no writes, no shared storage, not
  company-wide.
- **Tier 1** (another builder approves): company-wide, shared storage, or code the analysis cannot
  fully read (computed connector ids, `eval`).
- **Tier 2** (a platform reviewer approves): confidential data, writes or messages to other
  systems, or a budget above €50 a day.

An approval is for the exact bundle the reviewer read. Any change is a new version.

## Handler input

Handlers declare their input as a small JSON Schema (`string`, `number`, `boolean`, `array`,
`object`). The platform validates every input before the handler runs. A chat block's handler
takes `{ message: string, history?: [{ role, content }] }`.

## Results in the UI

Result views read a dotted path from the handler's return value: `markdown` (text), `table`
(an array of objects with named columns), `stats` (numbers with labels), `chart` (line or bar
over an array). Formats: `text`, `number`, `eur`, `percent`, `datetime`, `status`.
