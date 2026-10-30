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
- Done:
- Next: financial engine + golden numeric tests against mock assumptions
- Blockers:

## Machine D — dashboard / mocks / e2e
- Done: seed fixtures in `mocks/`; added assumption, scenario, business_plan and topic.research_incomplete fixtures
- Next: mock server with scripted event replay, layout of all panels
- Blockers:
