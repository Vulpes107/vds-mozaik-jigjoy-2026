# STATUS

Each machine edits **only its own section**. Update at every push. Blockers go in the top list too.

## Blockers (owner -> needs)
- none

## Phase
Phase 0 — contracts, shared runtime, skeleton

## Machine A — orchestrator / contracts
- Done: contracts additive pass (`project_id`, `research_incomplete`); events for progress/suggestion/gap/reassignment/override; `src/shared/validate.ts` (Ajv over contracts, reuse it); Allocator as pure `allocate(board, event)` with seeded tests (drop->reassign, no oscillation over 100 ticks, budget exhaustion -> `analysis.requested` with unresolved ids) plus the runtime participant; Topic Planner with validated `submit_topics` (demo: 35 topics on the sample profile via the gateway); CI on push/PR; models switched to gateway (Sonnet 4.6 / Haiku 4.5)
- Next: Cartographer -> `AgentEvent` + REST/SSE API, Operator checkpoints (topics.proposed -> topic.approved), per-topic budget InterceptionHandler, JSON snapshot + resume
- Blockers:

## Machine B — research
- Done:
- Next: Tavily wrapper with cache, Scout against mock Topic
- Blockers:

## Machine C — analysis
- Done:
- Next: financial engine + golden numeric tests against mock assumptions
- Blockers:

## Machine D — dashboard / mocks / e2e
- Done: seed fixtures in `mocks/`; added assumption, scenario, business_plan and topic.research_incomplete fixtures
- Next: mock server with scripted event replay, layout of all panels
- Blockers:
