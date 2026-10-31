# Strategy Swarm dashboard

React + TypeScript + Vite, one scrolling page, decision first. Reads A's REST + SSE API (ADR 0001); until A's server is up, use the mock.

```bash
cd dashboard && npm install
npm run mock        # mock API on :8787 (MOCK_SPEED=20 compresses the scripted replay)
npm run dev         # http://localhost:5173   (?run=<id> to pick a run, ?ro=1 for the read-only view)
npm run gen:types   # regenerate src/types/contracts.ts from ../contracts (never hand-edit it)
npm test            # derivation tests (allocation replay, cash curve, scenario grouping)
```
`VITE_API_URL` and `VITE_RUN_ID` override the API base and run id.

## Page order
Follows the reader's questions: verdict and key figures -> what to do -> can we afford it -> what could go wrong -> how sure are we -> who did the work -> proof -> export. While a run has no plan yet, live agent work and research lead instead. Every chart sits beside a "How to read it" column and a "What it shows right now" column; the second is generated from the data (`derive.ts`), so it cannot drift from the chart.

## Design
Editorial and typographic: Fraunces (display), Instrument Sans (UI), IBM Plex Mono (every number, tabular). Warm neutrals, one teal accent, semantic colours only for meaning. Light and dark are separate token sets. Agent roles use colour **and** shape. The five categorical colours were checked with the dataviz palette validator in both themes (dark has an adjacent CVD pair in the 6-8 band, which is why roles also carry a glyph and a label).

## Known limits
- No tornado chart: the contract does not carry per-assumption NPV swings, only `sensitivity_rank`. The assumption editor is ordered by that rank instead.
- Editing an assumption posts `{value}` and refetches; the recompute is the server's (C's engine), so figures update after the round trip, not in the browser.
- The cash curve is reconstructed from yearly totals and tranche releases; the engine's `min_cash_balance` is authoritative.
- The mock server replays only two events, so the allocation view shows a single reassignment.
- 390 px was checked in an iframe, not a real phone. Not yet exercised against A's real server.
