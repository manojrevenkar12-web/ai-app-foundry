# 2. The person using an app, not the app, decides what data it sees

Date: 2026-10-29. Status: accepted.

## Context

An app published to a group is used by many people with different rights. If an app had its own
data access (a service account), it would show each user whatever the app's builder could see.

## Decision

Every connector call runs as the viewer: the viewer's Entra groups decide which connectors answer
(`mayUse`), and every query runs in a transaction whose PostgreSQL settings carry the viewer's
countries, enforced by row-level security with `FORCE ROW LEVEL SECURITY` under a role without
`BYPASSRLS`. App records are isolated by app and viewer the same way. When group membership cannot
be determined (a token with group overage while Microsoft Graph is down), group-limited data is
refused (fail closed). The model gateway's answer cache includes the viewer's permission scope in
its key whenever tools run, so one person's cached answer is never served to another with
different rights.

## Consequences

- A builder cannot widen anyone's access by writing an app, and a reviewer does not need to check
  data access line by line: it is not the app's to decide.
- The fault model service reads all countries for training; the API checks that the viewer may
  see a charge point before asking it.
