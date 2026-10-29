# 4. Writes to other systems need the person's confirmation; models never get write tools

Date: 2026-10-29. Status: accepted.

## Context

An assistant that can comment on tickets or post to Teams is useful and dangerous: a prompt
injection in a ticket text could make the model write anything, anywhere the viewer can.

## Decision

Write connectors are not callable from `ctx.connectors.call` and are never offered to a model as a
tool. A handler can only return `ctx.confirm({ connector, args, summary })`; the platform stores
the request, shows the person exactly what will be sent, and performs the write only when that
person confirms, once, within ten minutes, while the app is still live. The write is recorded in
the hash-chained audit log under the confirming person.

## Consequences

- Prompt injection can at worst propose a write the person sees and can refuse.
- Previews cannot write; publishing is needed, which for write apps means a tier 2 review.
