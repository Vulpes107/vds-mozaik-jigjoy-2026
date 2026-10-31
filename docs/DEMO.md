# Demo script (3 minutes)

Golden company: `mocks/company_profile.sample.json` (Demo Logistics d.o.o., run `r_demo1`).

1. **Intake** — the landing page: the company profile form (logistics SME, considering build-vs-buy on route optimisation), the research limits with their recommendations, and the previous runs on the side.
2. **Topics** — Planner's topic list on the Research map panel; approve the `cp_topics` checkpoint.
3. **Dropped + reassigned** — watch the live feed: `t_002` ("Trade show calendar in unrelated region")
   is dropped for low relevance (0.12), and its agent `a_03` is reassigned onto `t_001`
   (competitor pricing) within a second. This is the hero moment — point it out explicitly.
4. **Plan** — the finished `BusinessPlan`: staged expansion recommendation, scenario comparison
   (Do nothing vs Expand), the `runway_breached` flag on the Expand case.
5. **Assumption edit** — change `as_001` (price per user) on the assumption editor; scenario
   metrics recompute and redraw live.

## Running it

```bash
# Mock server (serves mocks/ fixtures, replays the drop+reassign script over SSE)
node dashboard/mock-server/server.mjs            # http://localhost:8787, PORT env to override
MOCK_SPEED=200 node dashboard/mock-server/server.mjs   # compress the replay for a quick look

# Real run (devcontainer, keys in .env): API on :8787, dashboard proxies /runs to it
node --env-file=.env --import tsx src/orchestrator/server.ts
cd dashboard && npm run dev        # http://localhost:5173 -> intake form -> Start run

# E2E check (spawns the mock server itself, exits non-zero on breakage)
node e2e/run-demo.mjs
node e2e/run-demo.mjs --real   # against A's real server already running on PORT
```

## Fallback if Tavily/the model is down during the live demo

Run everything against `dashboard/mock-server/`: it serves the same REST+SSE shape as
`src/orchestrator/server.ts` (ADR 0001) from the fixtures in `mocks/`, so the dashboard
cannot tell the difference except for the "mock" badge the UI should show when pointed
at it.
