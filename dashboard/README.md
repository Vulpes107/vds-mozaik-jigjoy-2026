# Strategy Swarm dashboard

React + TypeScript + Vite, one scrolling page, decision first. Reads A's REST + SSE API (ADR 0001); until A's server is up, use the mock.

```bash
cd dashboard && npm install
npm run mock        # mock API on :8787 (MOCK_SPEED=20 compresses the scripted replay)
npm run dev         # http://localhost:5173   (?run=<id> to pick a run, ?ro=1 for the read-only view)
npm run gen:types   # regenerate src/types/contracts.ts from ../contracts (never hand-edit it)
npm test            # derivation tests (allocation replay, cash curve, scenario grouping)
```
Against the real orchestrator (from the repo root, in the devcontainer):

```bash
node --env-file=.env --import tsx src/orchestrator/server.ts   # A's API on :8787
cd dashboard && npm run dev                                     # proxies /runs to :8787
```
With no `?run=`, the page shows the newest run from `GET /runs`; if the server hosts none, the empty state has an intake form
(a `CompanyProfile`, prefilled from `mocks/company_profile.sample.json`) whose **Start run** posts it to `POST /runs` and reloads on the new id.
The dev server proxies `/runs` so the browser never makes a cross-origin call (`API_URL` picks another backend for the proxy).
`VITE_API_URL` and `VITE_RUN_ID` override the API base and run id in the built page.

## Design
Editorial and typographic: Fraunces (display), Instrument Sans (UI), IBM Plex Mono (every number, tabular). Warm neutrals, one teal accent, semantic colours only for meaning. Light and dark are separate token sets. Agent roles use colour **and** shape. The five categorical colours were checked with the dataviz palette validator in both themes (dark has an adjacent CVD pair in the 6-8 band, which is why roles also carry a glyph and a label).

## Known limits
- No tornado chart: the contract does not carry per-assumption NPV swings, only `sensitivity_rank`. The assumption editor is ordered by that rank instead.
- Editing an assumption posts `{value}` and refetches; the recompute is the server's (C's engine), so figures update after the round trip, not in the browser.
- The cash curve is reconstructed from yearly totals and tranche releases; the engine's `min_cash_balance` is authoritative.
- The mock server replays only two events, so the allocation view shows a single reassignment.
- 390 px was checked in an iframe, not a real phone.
- Against A's real server only the REST/SSE plumbing was exercised (run list, start, summary, 409, stream) with the planner and research switched off; no full LLM run through the UI yet.
