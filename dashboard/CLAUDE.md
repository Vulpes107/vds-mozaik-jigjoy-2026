# Machine D — Dashboard, Fixtures & End-to-End QA

You own `dashboard/`, `mocks/`, `e2e/`. Read root `CLAUDE.md` and `docs/MASTERPLAN.md` §9, §10, §11 first.

## Mission
One live page that shows everything: research progress, agent allocation, findings, scenarios, risks, and the final plan. Plus fixtures for every contract and the integration harness that keeps the four machines honest.

## Produces
`CompanyProfile` (intake form), `Assumption.user_override` edits. Fixtures in `mocks/`. E2E results in `STATUS.md`.

## Consumes
`AgentEvent` (SSE), `Topic`, `Finding`, `Source`, `Scenario`, `Assumption`, `BusinessPlan` via A's REST/SSE API. Until A exists, serve `mocks/` through a tiny mock server (`dashboard/mock-server/`) with a scripted event replay.

## Stack
React + TypeScript + Vite, with its own `dashboard/package.json` and lockfile (never add dependencies to the root `package.json`; that is A's). Types generated from `contracts/` (see `contracts/README.md`), committed under `dashboard/src/types/`, never hand-edited. Charts: Recharts or similar. Must work on a laptop screen and a projector.

## Panels (single page)
1. Header: company, run status, budget used, ETA.
2. Executive summary: top 3 recommendations + overall confidence.
3. Decision panel: continue-vs-change scorecard, investment range (low/base/high), build-vs-buy verdicts with flip point.
4. Financials: scenario comparison, revenue/cost curves, NPV/IRR/payback, tornado chart, **assumption editor** (edit -> recompute -> redraw).
5. Research map: topics by importance vs confidence, state chips, dropped topics with reason.
6. **Agent activity:** live feed + allocation view that visibly shows reassignments (dropped topic -> agent moves). This is the demo's hero feature.
7. Risk register heat matrix with mitigations.
8. Roadmap timeline with gates and kill criteria.
9. Evidence browser: findings/sources, conflicts highlighted, link-through from any recommendation to its findings and assumptions ("why this?").
10. Export: PDF / Markdown / JSON; read-only share link.

## UX rules
- Always show confidence, ranges, and "as of" dates; never show a bare precise number for an estimate.
- Surface `unresolved_topic_ids`, stale findings, and `injection_flagged` sources visibly.
- Human checkpoints: approve topic list and budget before the run proceeds; clear pending-action banner.
- Handle: empty state, partial plan (budget exhausted), SSE reconnect with `Last-Event-ID`, failed run, very long lists (virtualise).
- Accessibility basics: contrast, keyboard navigation, no colour-only encoding.

## Fixtures (`mocks/`)
Naming: `<schema_name>.<variant>.json` so `npm run validate` picks the right schema. Keep at least: normal case, dropped topic, conflicting findings, low-confidence run, budget-exhausted partial plan, `runway_breached` scenario, injection-flagged source. Add 3 diverse golden companies (e.g. logistics SME, SaaS startup, manufacturing).

## E2E harness (`e2e/`)
Run the full pipeline on a golden company against `main` on a schedule; report breakages to the owning machine in `STATUS.md`. Include failure-injection (Tavily outage, malformed finding, killed process) and the privacy check (nothing sensitive in logs).

## Demo script
Keep `docs/DEMO.md` current: a 3-minute path showing intake -> topics -> a topic being dropped and its agent reassigned -> plan with scenarios -> assumption edit recalculating live.

## Do not touch
`src/orchestrator/`, `src/research/`, `src/analysis/`, `contracts/` (request changes from A).

## Mozaik implementation (D)
- Mozaik cloud (app.jigjoy.ai) already shows agents/events live; use it as a debugging view. Our dashboard consumes A's `Cartographer` SSE feed (`AgentEvent`) plus REST.
- Pair this machine with `npx @mozaik-ai/cloud-sdk pair` or set `MOZAIK_API_KEY` in `.env`.
- Test helpers: build the mock server on `mocks/` and replay events with realistic timing; keep one scripted run that visibly drops a topic and reassigns its worker slot.
