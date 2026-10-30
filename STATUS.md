# STATUS

Each machine edits **only its own section**. Update at every push. Blockers go in the top list too.

## Blockers (owner -> needs)
- none

## Phase
Phase 0 — contracts, shared runtime, skeleton

## Machine A — orchestrator / contracts
- Done: contracts additive pass (`project_id` on all schemas, topic state `research_incomplete`); new events `TopicProgress`, `TopicSuggested`, `ResearchGap`, `ReassignmentRequested`, `AssumptionOverridden`; ownership of root `package.json`/lockfile/`config/`/`docs/adr/`; B<->A interface fixed as in-process events only
- Next: freeze schemas, CI (`npm run check`), task board
- Blockers:

## Machine B — research
- Done (branch `b/research-agents`, `src/research/`, see its README): provider-neutral `web_search`/`web_fetch` over `SearchProvider`/`FetchProvider` + Tavily adapter (+ optional `tavily_map/crawl/research`); gateway with outbound query redaction, cache by (tool,args) hash, rate limit, retry/backoff, provider fallback, per-topic/run call budgets, usage metering, injection scan + `UNTRUSTED` quoting; Source library (reliability scoring, origin dedupe); `submit_finding`/`submit_source`/`report_scores`/`save_material`/`record_verification`/`suggest_topic`/`report_gap` tools validated against `contracts/`; Scout/Collector/Analyst/Verifier factories; slot worker with fresh-agent-per-task, handoff, hard token/tool-call/time limits, reassignment; 128 tests green (all CLAUDE.md-required cases + E2E on the real Mozaik runtime with a scripted fake model)
- Not yet done: no live run with real Tavily + model (no `TAVILY_API_KEY` on this machine; `src/research/smoke.ts` is ready); prompts untuned
- Next: live smoke run, tune prompts on the golden companies, chaos/failure-injection tests (Phase 4)
- Asks for A (not touching your paths):
  - `src/shared/events.ts`: add typed payloads for `TaskFinished` (`{slotId, role, topicId, outcome: done|budget_exhausted|timeout|error, summary?, findings, sources}`) and the extra `TopicScored` fields (`evidenceQuality`, `searches`). B already sends exactly these; extra fields are safe to ignore.
  - `startRuntime(runId, config?)`: pass through `inferenceRunnerConfig` (B's `agents/worker.test.ts` calls `initializeRuntime` directly to inject a fake model). Also wrap the inference runner so a failed LLM call publishes an event: Mozaik loops are fire-and-forget, so today a 400/network error is an unhandled rejection and B only notices via its per-task timeout.
  - Allocator contract B relies on: set `Topic.state = "deep"` for deep work (anything else is treated as shallow); `Topic.budget.{tokens,seconds,calls}` are honoured as hard limits; a reassigned slot gets a new `task.assigned` (B stops the old agent silently and sends no `task.finished` for it).
  - B meters provider calls itself and enforces `runBudget.calls`; it does not write `RunState.spent`. Say if you want a usage event.
  - `.example.env` has no `TAVILY_API_KEY`. `npm test`'s `src/**/*.test.ts` glob only expands on Node 22+ (this machine ran Node 20; the devcontainer is 22).
- Blockers:

## Machine C — analysis
- Done:
- Next: financial engine + golden numeric tests against mock assumptions
- Blockers:

## Machine D — dashboard / mocks / e2e
- Done: seed fixtures in `mocks/`; added assumption, scenario, business_plan and topic.research_incomplete fixtures
- Next: mock server with scripted event replay, layout of all panels
- Blockers:
