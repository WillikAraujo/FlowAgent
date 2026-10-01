# ADE-106 — Codex passive detection

## Scope

This isolated implementation reports only whether a statically named Codex executable appears in a PATH directory. It checks filesystem metadata and does not launch Codex, execute tasks, open sessions, or inspect authentication, configuration, credential files, environment contents beyond the PATH value, or session state. Authentication is always unknown.

The adapter contract here is provisional and local to this path. Do not wire it to IPC, persistence, or shared domain types until Atlas defines and approves the shared AgentAdapter, detection, and capability contracts.

## Result and capability behavior

detect() returns JSON-safe provider, availability (present, absent, or unknown), authentication (unknown), an observation timestamp, and a non-sensitive reason. It never returns a candidate path. Missing/unusable PATH or unexpected filesystem metadata produces unknown; a metadata lookup that finds no matching executable produces absent.

capabilities() marks detection supported and session creation, resumption, task sending, event streaming, cancellation, and termination unsupported. Capabilities describe this implementation only; they do not imply Codex login state.

## Validation

Run:

node --experimental-strip-types --test tests/adapters/codex-adapter.test.mjs

Tests inject metadata lookups and cover executable present/absent, unavailable PATH, malformed metadata, access errors, non-files/non-executable files, authentication remaining unknown, and unsupported operations. They do not invoke any CLI or process launcher.
