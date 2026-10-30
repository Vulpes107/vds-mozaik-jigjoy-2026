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
- Done (branch `b/research-agents`, `src/research/`, see its README): provider-neutral `web_search`/`web_fetch` over `SearchProvider`/`FetchProvider` + Tavily adapter (+ optional `tavily_map/crawl/research`); gateway with outbound query redaction, cache by (tool,args) hash, rate limit, retry/backoff, provider fallback, per-topic/run call budgets, usage metering, injection scan + `UNTRUSTED` quoting; Source library (reliability scoring, origin dedupe); `submit_finding`/`submit_source`/`report_scores`/`save_material`/`record_verification`/`suggest_topic`/`report_gap` tools validated against `contracts/`; Scout/Collector/Analyst/Verifier factories; slot worker with fresh-agent-per-task, handoff, hard token/tool-call/time limits, reassignment; 128 tests green (all CLAUDE.md-required cases + E2E on the real Mozaik runtime with a scripted fake model)
- Not yet done: no live run with real Tavily + model (no `TAVILY_API_KEY` on this machine; `src/research/smoke.ts` is ready); prompts untuned
- Done (branch `b/spend-reporting`): each task reports its search/fetch calls as `topic.progress.spent.calls` at the end
- Next: live smoke run, tune prompts on the golden companies, chaos/failure-injection tests (Phase 4); switch `validate.ts` to a wrapper over `src/shared/validate.ts` once `a/integration` is merged (it needs the property name in the message)
- Asks for A, answered on `a/integration` (typed payloads, `startRuntime(runId, inferenceRunnerConfig?)`, unhandled-rejection guard, `task.finished.outcome` honoured, `TAVILY_API_KEY` in `.example.env`). Original list:
  - `src/shared/events.ts`: add typed payloads for `TaskFinished` (`{slotId, role, topicId, outcome: done|budget_exhausted|timeout|error, summary?, findings, sources}`) and the extra `TopicScored` fields (`evidenceQuality`, `searches`). B already sends exactly these; extra fields are safe to ignore.
  - `startRuntime(runId, config?)`: pass through `inferenceRunnerConfig` (B's `agents/worker.test.ts` calls `initializeRuntime` directly to inject a fake model). Also wrap the inference runner so a failed LLM call publishes an event: Mozaik loops are fire-and-forget, so today a 400/network error is an unhandled rejection and B only notices via its per-task timeout.
  - Allocator contract B relies on: set `Topic.state = "deep"` for deep work (anything else is treated as shallow); `Topic.budget.{tokens,seconds,calls}` are honoured as hard limits; a reassigned slot gets a new `task.assigned` (B stops the old agent silently and sends no `task.finished` for it).
  - B meters provider calls itself and enforces `runBudget.calls`; it does not write `RunState.spent`. Say if you want a usage event.
  - `.example.env` has no `TAVILY_API_KEY`. `npm test`'s `src/**/*.test.ts` glob only expands on Node 22+ (this machine ran Node 20; the devcontainer is 22).
- Blockers:

## Machine C — analysis
- Done: engine in `src/analysis/engine/` (safe formula evaluator, NPV/IRR/payback/break-even, scenarios with low/base/high = adverse/base/favourable per assumption, tornado + break-even values, build-vs-buy TCO with flip point, option scoring by risk appetite, deterministic red team, `BusinessPlan` assembler); Mozaik layer (`AnalysisSession`, 5 tools, Financial / BuildBuy / Synthesizer agents, `registerAnalysis` conductor + recomputer for `EV.AssumptionOverridden`, no LLM on that path); 38 tests incl. full chain through the real runtime with a scripted fake model; every output validated against `contracts/`.
- Next: run against a real model + real findings from B; Monte Carlo (optional); golden companies with D.
- Blockers / asks:
  - **A:** move `ajv` and `ajv-formats` from devDependencies to dependencies (used at runtime by `src/analysis/contracts.ts`).
  - **A:** install a process-level `unhandledRejection` handler in the app entry: a failing model call rejects inside Mozaik's detached loop.
  - **A/B:** to start analysis send `EV.AnalysisRequested` from any joined participant after research; `RunState.profile/findings/topics` must be populated first.

## Machine D — dashboard / mocks / e2e
- Done: seed fixtures in `mocks/`; added assumption, scenario, business_plan and topic.research_incomplete fixtures
- Next: mock server with scripted event replay, layout of all panels
- Blockers:
