# ADR 0001: REST + SSE on Node's built-in `http`

Status: accepted (2026-10-30, Machine A)

The API is small (7 routes, one SSE stream) and local/single-user in v1. Node 22's `http` module covers it with no dependency, no framework upgrade path to manage, and nothing for the other machines to install. Revisit (Hono) if routing or middleware grows beyond one file.

One process hosts one run: `@mozaik-ai/core` initialises its runtime once per process, so `POST /runs` returns 409 while a run is live. Multi-run hosting means one process per run behind a tiny router; out of scope for v1.
