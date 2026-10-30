# Machine B — research agents

Turns a `Topic` into sourced `Finding`s. Wire-up for the orchestrator (A):

```ts
import { startRuntime } from "../shared/runtime.ts"
import { startResearch, tavilyProviders } from "./research/index.ts"

const state = startRuntime(runId)
state.profile = profile                       // set before startResearch (redaction reads it live)
const { search, fetch, extras } = tavilyProviders()   // needs TAVILY_API_KEY in this machine's .env
startResearch({ state, searchProviders: [search], fetchProviders: [fetch], extras, slots: ["slot_1", "slot_2"] })
// Allocator: sendEvent(SemanticEvent.create(EV.TaskAssigned, id, { slotId, role, topicId, handoff? }), id)
```

## What B does with events
| In | Out |
|---|---|
| `task.assigned` for one of its slot ids | a fresh Agent for `role` runs the task; on completion `task.finished` |
| (Scout) | `topic.scored` `{topicId, relevance, impact, rationale, evidenceQuality, searches}` |
| (any worker) | `source.submitted`, `finding.submitted` (`updated: true` on changes), `conflict.detected`, `injection.flagged`, `topic.progress` (confidence computed in code), `topic.suggested`, `research.gap` |

`task.finished` payload: `{ slotId, role, topicId, outcome: "done"|"budget_exhausted"|"timeout"|"error", summary, findings, sources }`.
A superseded task (new `task.assigned` for a busy slot) is stopped silently and gets **no** `task.finished`.
B only writes `RunState.findings` / `RunState.sources`. It reads `topics`, `profile`, `runBudget`, `Topic.budget`.

## Layout
- `tools/` provider-neutral layer: `provider.ts` (interfaces), `tavily.ts` (first adapter), `gateway.ts` (redaction → cache → budget → rate limit → retry → fallback → metering → injection scan), `web-tools.ts` (the `web_search` / `web_fetch` FunctionTools + optional `tavily_*` extras).
- `store.ts` + `submit-tools.ts` — the only writers of Findings/Sources; validate against `contracts/`, normalise numbers in code, link conflicts, enforce independent verification.
- `scoring.ts` — deterministic reliability, freshness, confidence caps, unit/FX normalisation.
- `safety/injection.ts` — directive stripping + `UNTRUSTED` quoting.
- `agents/` — `makeScout/Collector/Analyst/Verifier` and the slot worker (hard limits via an `InterceptionHandler`).
- `smoke.ts` — manual run against real Tavily + a real model.

## Adding a provider
Implement `SearchProvider` / `FetchProvider` (and optionally `ResearchExtras`) and pass it to `startResearch`. Nothing in `agents/` changes (`gateway.test.ts` proves it with a second fake adapter). Providers are tried in order; the first that answers wins.

## Tests
`node --import tsx --test $(find src/research -name '*.test.ts')`. `agents/worker.test.ts` drives the real Mozaik runtime with a scripted fake model (no keys, no network; cloud telemetry is disabled inside that file).
