# 3. Review effort follows what an app can reach; approval is for an exact bundle

Date: 2026-10-29. Status: accepted.

## Context

A review step that applies to everything becomes a rubber stamp. One that applies to nothing lets
confidential data and writes into production unseen.

## Decision

The publish gate assigns a tier from the manifest and the code analysis:

- Tier 0 (publishes after the automatic checks): internal data only, no writes, no shared storage,
  limited audience.
- Tier 1 (a second builder approves): company-wide audience, shared collections, or code the
  reviewer should read (dynamic code, computed connector ids).
- Tier 2 (a platform reviewer approves): confidential data, writes to other systems, data leaving
  the platform, or a budget above the threshold in configuration.

An approval names the SHA-256 of the canonical bundle; any change is a new version and a new
review. Authors and owners cannot approve their own apps.

## Consequences

- Most apps people build (lookups, assistants over internal data, private notebooks) publish
  without waiting for anyone.
- The runtime enforces the manifest whatever the gate decided, so a gate mistake does not become
  access: the held-out runner measures the runtime with the gate switched off.
