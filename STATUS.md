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
- Done:
- Next: Tavily wrapper with cache, Scout against mock Topic
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
