# Machine A — Orchestration & Core

You own `src/orchestrator/`, `src/shared/` and `contracts/`. Read root `CLAUDE.md` and `docs/MASTERPLAN.md` §3, §4, §6 first.

## Mission
Run lifecycle, Topic Planner, shared Task Board, **dynamic Allocator**, budgets, event bus, API server. You are the only writer of `Topic` state and `AgentEvent`.

## Produces
- `Topic` (planner output + state transitions), `AgentEvent` stream.
- HTTP API (Node `http`/Hono/Fastify - pick one in an ADR): `POST /runs` (CompanyProfile), `GET /runs/{id}`, `GET /runs/{id}/topics`, `POST /runs/{id}/topics/{tid}/approve`, `GET /runs/{id}/events` (SSE, supports `Last-Event-ID`), `POST /runs/{id}/checkpoints/{cid}` (human approve/reject), `GET /runs/{id}/plan`.
- Agent-facing interface (used by B and C) is in-process events only, no HTTP: tasks via `EV.TaskAssigned`; B reports via `EV.TopicScored`, `EV.TopicProgress`, `EV.TopicSuggested`, `EV.ResearchGap`, `EV.ReassignmentRequested`, and writes `Finding`/`Source` directly to `RunState` then emits `EV.FindingSubmitted`/`EV.SourceSubmitted`. Dashboard assumption edits arrive at your API and go out as `EV.AssumptionOverridden` for C.

## Consumes
`CompanyProfile` (from D), `Finding`/`Source` (from B), `BusinessPlan`/`Scenario` (from C).

## Allocation rules (implement exactly; make thresholds config, not constants)
- Scout gate: `relevance < 0.3` -> **dropped**; `relevance >= 0.3 && impact < 0.4` -> **shallow** (1 Scout + 1 Analyst cap); `impact >= 0.4` -> **deep** (Verifier required).
- Freed agents -> topic with max `priority = impact * (1 - confidence) / (1 + agents_assigned)`.
- Close early when marginal value of the last N steps falls below threshold.
- Conflicting sources or low confidence on high impact -> escalate (add Verifier / 2nd Collector).
- **Anti-thrash:** min dwell time per assignment; hysteresis (drop at 0.30, reopen only above 0.35 *with new evidence*); max reassignments per agent; record `reassignment_count`.
- Analyst-proposed topics enter the board only after Planner scoring; enforce a global topic cap.
- Always record `state_reason` for dropped/shallow/closed. Dropped topics stay visible.
- Stop when all non-dropped topics closed or budget/time exhausted; list unresolved topics for the plan.

## Planner requirements
Cover all 16 categories in `topic.schema.json` or log why a category is skipped. Merge duplicates. Handle multi-product profiles (`product_scope`). If the profile is thin, ask <=3 clarifying questions via a checkpoint, then continue with stated assumptions.

## Reliability
Idempotent tasks, retry with backoff, persisted state, resume from checkpoint after crash, circuit breakers on Tavily/LLM failures, per-topic and per-run budgets with `budget_warning` at 80%.

## Tests you must have
Seeded simulation proving: a low-relevance topic is dropped within one scout cycle and its agent is reassigned; no oscillation over 100 simulated ticks; budget exhaustion yields a partial plan with `unresolved_topic_ids`; crash/resume reproduces state.

## Contracts duty
You are the gatekeeper of `contracts/`. Keep `npm run validate` green; review every schema PR from other machines; publish generated types (`npx json-schema-to-typescript`).

## Do not touch
`src/research/`, `src/analysis/`, `dashboard/`, `mocks/` (ask D for fixtures).

## Mozaik implementation (A)
- `src/shared/runtime.ts` is yours: the single runtime and `RunState`. Keep it small and stable; other machines import from it.
- **Participants you create:** `Planner` (Agent, structured output = `Topic[]`), `Allocator` (code-only `createHuman`, no LLM), `Cartographer` (code-only observer that maps every runtime event to an `AgentEvent` for the dashboard SSE feed), `Operator` (bridges human checkpoints).
- **Allocator** reacts to `EV.TopicScored`, `EV.TaskFinished`, `EV.SlotIdle`, `EV.FindingSubmitted`; it mutates `RunState.topics/slots` and emits `EV.TopicStateChanged`, `EV.TopicDropped`, `EV.TaskAssigned`. It is the only writer of `RunState.slots`.
- Keep thresholds in a config object so tests can drive them; the allocator logic itself must be a pure function `(state, event) -> actions[]` that you unit-test without the runtime, then a thin handler applies the actions.
- Use `InterceptionHandler` (4th arg of `runLoop`) to enforce per-topic budgets: rewrite the next transition to `model_message` when the budget is exhausted.
- Mozaik cloud shows your agents and events live for free; the custom dashboard uses the Cartographer feed.
