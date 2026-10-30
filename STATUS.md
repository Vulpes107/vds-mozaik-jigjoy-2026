# STATUS

Each machine edits **only its own section**. Update at every push. Blockers go in the top list too.

## Blockers (owner -> needs)
- none

## Phase
Phase 0 — contracts, shared runtime, skeleton

## Machine A — orchestrator / contracts
- Done (branch `a/allocator`): contracts additive pass; new events; `src/shared/validate.ts`; Allocator (pure `allocate` + participant, seeded tests); Topic Planner with validated `submit_topics`; Cartographer -> `AgentEvent`; Operator checkpoint `cp_topics`; REST+SSE API (`src/orchestrator/server.ts`, ADR 0001); Meter (tokens/USD -> `spend.recorded`); JSON snapshots + `resumeRun`; `budgetInterceptor(topicId)` for workers' `runLoop`; CI; gateway models; audit must-fixes (localhost-only API, default run budget `{usd: 2, seconds: 1800}`, unhandled-rejection guard, stale `task.finished` guard, scout-no-score retry, `allocator.tick` task timeouts + wall clock)
- For B/C: import `validate` from `src/shared/validate.ts`; pass `budgetInterceptor(topicId)` as 4th arg of `runLoop`; start a run with `startRun(profile, opts)` from `src/orchestrator/run.ts` or `POST /runs`
- Next: PR to main; per-topic `budget` set by planner/allocator; analyst-proposed topics (`topic.suggested`) scored by Planner; clarifying-questions checkpoint for thin profiles
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
