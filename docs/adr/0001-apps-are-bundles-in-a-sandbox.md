# 1. Apps are declarative bundles run in a fresh sandbox, not containers

Date: 2026-10-29. Status: accepted.

## Context

Everyone at EDRI should be able to build an AI app, mostly with AI coding tools, while login,
data access, hosting and security are the platform's. A container per app (what most "deploy your
vibe-coded app" platforms do) gives each app a whole operating system: network, files, arbitrary
packages, its own idea of authentication. Every one of those is a place where a generated app can
leak data, and reviewing it means reading everything.

## Decision

An app is four files: a manifest that declares everything it may reach (connectors, model aliases,
collections, audience, budget), `handlers.js`, a UI made of platform blocks (`ui.json`), and tests.
Handlers run in a fresh QuickJS (WebAssembly) runtime per invocation, with CPU, memory, stack,
wall time, call count and output limits, and exactly one way out: `ctx`, which the platform
implements and checks against the manifest on every call. The UI is data rendered by the console,
so an app cannot run script in a colleague's browser.

## Consequences

- An app's whole capability set fits on one screen (the manifest, drawn as the wiring plate), which
  makes review possible for people who do not read code.
- Apps cannot use npm packages, timers or the network. Most internal tools do not need them; those
  that do need a connector, which the platform team reviews once for everyone.
- `eval` and `Function` are flagged, not blocked: inside the sandbox they reach nothing `ctx` does
  not already offer.
