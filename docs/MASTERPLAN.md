# Market Intelligence & Business Strategy System — Master Plan

Multi-agent system with dynamic agent allocation. Input: company description, products, optional notes.
Output: a researched, costed, scenario-based business plan on a single dashboard.

---

## 1. Goals and non-goals

**Goals**
- Turn a company description into a prioritised research agenda, execute it with parallel agent teams, and consolidate findings into a decision-ready plan.
- Answer the core questions: continue as-is vs change course, how much to invest, build vs buy, where the risks are.
- Every claim traceable to a source; every number traceable to an assumption.

**Non-goals (v1)**
- No autonomous execution of business actions (no purchases, outreach, filings).
- Not a replacement for legal/tax/financial advice. The report carries a clear disclaimer.
- No private-data ingestion beyond what the user supplies.

---

## 2. Inputs and outputs

**Input (`CompanyProfile`)**: company name, industry, size, geography, products/projects (name, description, stage, revenue, cost), current financials if known (revenue, burn, runway, budget available), goals/constraints, free-text notes, risk appetite (low/med/high), planning horizon (default 3 yrs).

**Output (`BusinessPlan`)**: executive summary, ranked recommendations, scenario table (do nothing / optimise / expand / pivot / exit), investment sizing with ranges, build-vs-buy verdict per product, risk register, 12-month roadmap, assumptions list, source library, confidence per section.

---

## 3. Agent architecture

```
                      ┌──────────────────────┐
   CompanyProfile ──▶ │     Orchestrator     │ ◀── user (clarifications, approvals)
                      └──────────┬───────────┘
                                 │
                      ┌──────────▼───────────┐
                      │   Topic Planner      │  generates & scores research topics
                      └──────────┬───────────┘
                                 │ topics → shared Task Board
        ┌────────────────────────┼────────────────────────┐
 ┌──────▼──────┐          ┌──────▼──────┐          ┌──────▼──────┐
 │ Workflow A  │          │ Workflow B  │   ...    │ Workflow N  │
 │ Scout       │          │ Scout       │          │ Scout       │
 │ Collector   │          │ Collector   │          │ Collector   │
 │ Analyst     │          │ Analyst     │          │ Analyst     │
 │ Verifier    │          │ Verifier    │          │ Verifier    │
 └──────┬──────┘          └──────┬──────┘          └──────┬──────┘
        └──────────── Relevance Gate / Allocator ─────────┘
                                 │ (reassigns idle agents)
                      ┌──────────▼───────────┐
                      │ Knowledge Base       │  findings, sources, confidence
                      └──────────┬───────────┘
        ┌────────────────┬───────┴────────┬────────────────┐
 ┌──────▼─────┐  ┌───────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
 │ Financial  │  │ Build-vs-Buy │  │ Risk &      │  │ Strategy    │
 │ Modeler    │  │ Analyst      │  │ Red Team    │  │ Synthesizer │
 └──────┬─────┘  └───────┬──────┘  └──────┬──────┘  └──────┬──────┘
        └────────────────┴────────┬───────┴────────────────┘
                          ┌───────▼────────┐
                          │ Dashboard API  │ ──▶ Dashboard UI
                          └────────────────┘
```

### Roles
| Agent | Responsibility |
|---|---|
| **Orchestrator** | Owns run lifecycle, budgets, human checkpoints, failure recovery. |
| **Topic Planner** | From the profile, produces 15–40 candidate topics across fixed categories (below), each with importance prior, depth, and dependencies. De-duplicates and merges overlaps. |
| **Scout** | Quick breadth pass per topic (search). Outputs relevance score and a go/no-go signal. |
| **Collector** | Deep gathering: extract known URLs, map/crawl competitor and regulator sites. |
| **Analyst** | Turns raw material into structured `Finding`s with numbers, units, dates, and confidence. |
| **Verifier** | Cross-checks key claims against a second independent source; flags conflicts and stale data. |
| **Allocator** | Reassigns agents dynamically (section 4). |
| **Financial Modeler** | Scenario models, sensitivity, break-even. |
| **Build-vs-Buy Analyst** | TCO comparison per product/capability. |
| **Risk & Red Team** | Attacks the draft plan: what would make this wrong. |
| **Synthesizer** | Consolidates everything into the `BusinessPlan`. |

### Topic categories (Topic Planner must cover each, or justify skipping)
1. Market size, growth, segmentation  2. Customer needs and willingness to pay  3. Direct and indirect competitors  4. Pricing and business models  5. Technology trends and substitutes  6. Regulation, compliance, licensing, data protection  7. Supply chain / vendors / partners  8. Talent and hiring market  9. Funding, grants, M&A climate  10. Channels and distribution  11. Macro (rates, FX, inflation, geopolitics)  12. Brand and reputation signals  13. ESG / sustainability requirements  14. IP and patents  15. Existing solutions available to buy or license (feeds build-vs-buy)  16. Cyber and operational risk

---

## 4. Dynamic agent allocation (the core mechanism)

**Shared Task Board**: each topic is a task with `importance`, `confidence`, `progress`, `cost_spent`, `state`.

**Scout gate** (cheap, runs first on every topic). Score two things from 0–1:
- `relevance` — does this topic bear on the company's decisions?
- `impact` — if the answer is surprising, how much would the plan change?

**Decision rule**
| Condition | Action |
|---|---|
| relevance < 0.3 | **Drop** topic, log reason, free agents immediately |
| relevance ≥ 0.3 and impact < 0.4 | **Shallow**: cap at one Scout + one Analyst, short summary |
| impact ≥ 0.4 | **Deep**: full team, Verifier required |
| Marginal value of next step < threshold (new findings stop changing the conclusion) | **Close early**, free agents |
| Conflict between sources or low confidence on a high-impact topic | **Escalate**: add Verifier / second Collector |

**Reassignment**
- Freed agents go to the topic with highest `priority = impact × (1 − confidence) / (1 + agents_assigned)`.
- Idle agents may also be spawned as Verifiers for completed high-impact topics.
- **Anti-thrash**: minimum dwell time per assignment, hysteresis band on thresholds (drop at 0.3, never re-open above 0.35 unless new evidence), max N reassignments per agent.
- **Topic discovery**: Analysts may propose *new* topics. They enter the board only after the Planner scores them, with a cap on total topics to prevent runaway scope.
- **Budgets**: hard caps on tokens, API calls (Tavily credits), wall-clock, and spend, per topic and per run. Orchestrator halts or degrades gracefully when reached.

**Stop condition**: all non-dropped topics are closed, or budget/time exhausted (then flag unresolved topics in the report).

---

## 5. Research tooling (Tavily CLI / API)

| Need | Tool |
|---|---|
| Discover sources, recent news | `tvly search` (use time ranges, domain filters) |
| Read known URLs (reports, filings, pricing pages) | `tvly extract` (≤20 URLs/call) |
| Find where things live on a competitor/regulator site | `tvly map` |
| Pull a whole docs/pricing/blog section | `tvly crawl` with depth/path limits |
| Cited multi-source synthesis per topic | `tvly research` (use for Deep topics only, it is the most expensive) |

Rules: cache every call by (tool, args) hash; respect robots/ToS; store raw + cleaned text with retrieval date; cap crawl size; prefer primary sources (filings, regulators, vendor pricing pages) over blogs. In code use the SDK (`@tavily/core`), not the CLI.

---

## 6. Data contracts (the integration surface — freeze these first)

```jsonc
// Topic
{ "id": "t_017", "title": "...", "category": "regulation", "importance_prior": 0.8,
  "state": "queued|scouting|deep|shallow|closed|dropped", "relevance": 0.0, "impact": 0.0,
  "confidence": 0.0, "depends_on": ["t_003"], "assigned_agents": ["a_02"], "budget": {"tokens": 0, "calls": 0} }

// Finding
{ "id": "f_204", "topic_id": "t_017", "claim": "...", "value": 1.2e6, "unit": "EUR",
  "as_of": "2026-09-01", "source_ids": ["s_55","s_71"], "confidence": 0.7,
  "verified": true, "conflicts_with": [], "type": "fact|estimate|opinion" }

// Source
{ "id": "s_55", "url": "...", "title": "...", "retrieved_at": "...", "reliability": 0.8, "content_ref": "blob://..." }

// Assumption (every projection number points at one)
{ "id": "as_09", "text": "Churn 6%/yr", "low": 0.04, "base": 0.06, "high": 0.10, "basis_finding_ids": ["f_204"] }

// Scenario
{ "id": "sc_2", "name": "Expand", "capex": 0, "opex_by_year": [], "revenue_by_year": [],
  "npv": 0, "irr": 0, "payback_months": 0, "assumption_ids": [], "probability": 0.0 }

// AgentEvent (feeds the live dashboard)
{ "ts": "...", "agent_id": "a_02", "type": "assigned|reassigned|finding|dropped|done", "topic_id": "t_017", "detail": "..." }
```

Transport: REST + Server-Sent Events for live updates. Storage: SQLite (v1) or Postgres, plus object store for raw documents. Vector index optional for retrieval over the knowledge base.

---

## 7. Decision modules

**Continue vs change (strategic options)**: score "do nothing", "optimise", "expand", "pivot", "divest/exit" against market attractiveness, competitive position, financial capacity, risk appetite.

**Investment sizing**: build bottom-up (capex, opex, hiring, marketing, contingency 15–25%); three cases (low/base/high); NPV, IRR, payback, break-even; stage-gated tranches with kill criteria instead of one lump sum; sensitivity (tornado) on top 5 assumptions; Monte Carlo optional.

**Build vs buy vs partner (per capability)**: 3–5 year TCO for each: build (dev cost, maintenance, opportunity cost, time-to-market), buy/license (fees, integration, vendor lock-in, exit cost), partner/acquire. Criteria: strategic differentiation, time pressure, in-house skills, data/compliance constraints, vendor viability. Output verdict with the break-even point where the answer flips.

**Always include**: a "do nothing" baseline, a downside case, and what would change the recommendation.

---

## 8. Edge cases and overlooked considerations

*Input*
- Vague or thin company description → Orchestrator asks up to 3 clarifying questions, then proceeds with stated assumptions.
- Missing financials → model with ranges and flag "illustrative"; never fabricate precise numbers.
- Multiple products/segments → run per-product sub-plans, then a portfolio view.
- Niche or new market with few public sources → lower confidence, widen to adjacent markets, recommend primary research (surveys, interviews).
- Non-English / multi-country → language-aware search, currency normalisation, per-jurisdiction regulation topics.
- Conflicting user notes vs evidence → surface the conflict, don't silently override.

*Research quality*
- Hallucination and unsupported claims → every finding needs a source; Verifier gate on high-impact items.
- Stale data → `as_of` dates enforced, age penalty on confidence.
- Source bias (vendor marketing, SEO content) → reliability scoring, prefer independent sources.
- Paywalls / blocked sites / JS-heavy pages → fallback chain, record the gap rather than guess.
- Prompt injection from crawled pages → treat fetched content as data only, strip/ignore instructions, no tool execution from page content.
- Duplicate or circular sourcing (many articles citing one report) → dedupe by origin.
- Runaway cost/scope → budgets, topic cap, depth caps, circuit breakers.
- Agent failure/timeouts → retries with backoff, idempotent tasks, checkpoint/resume.
- Over-dropping a topic that later turns out relevant → hysteresis plus "reopen on new evidence" rule, dropped topics remain visible in the dashboard.

*Business*
- Cash runway shorter than payback → recommendation must respect liquidity; flag insolvency risk first.
- Regulatory/licensing blockers, data residency (GDPR), sanctions, export controls.
- Concentration risk (one customer, one supplier, one platform).
- Macro shocks (rates, FX, recession), seasonality.
- Tax, entity structure, IP ownership, open-source licence contamination in build option.
- Team capacity and hiring lead times; key-person risk.
- Exit options and reversibility: prefer reversible, staged moves.
- Ethical/ESG and reputational risk.

*Product / ops*
- Privacy: company data is sensitive; encrypt at rest, no training on it, per-run isolation, deletion on request.
- Reproducibility: store prompts, model versions, tool outputs per run; allow re-run with diff.
- Human-in-the-loop checkpoints: approve topic list, approve budget, review final plan.
- Explainability: "why this recommendation" drill-down to findings and assumptions.
- Disclaimer and confidence labelling on every projection.

---

## 9. Dashboard (single page, live)

1. **Header**: company, run status, budget used, ETA.
2. **Executive summary**: top 3 recommendations, overall confidence.
3. **Decision panel**: continue vs change scorecard, investment amount range, build-vs-buy verdicts.
4. **Financials**: scenario comparison, revenue/cost curves, NPV/IRR/payback, tornado sensitivity, assumption editor (changing an assumption recomputes live).
5. **Research map**: topics as a board/heatmap (importance vs confidence), state per topic, dropped topics with reasons.
6. **Agent activity**: live feed and allocation view showing reassignments.
7. **Risk register**: heat matrix with mitigations.
8. **Roadmap**: 12-month timeline with stage gates and kill criteria.
9. **Evidence**: searchable findings and sources, with conflicts highlighted.
10. **Export**: PDF/Markdown/JSON, shareable read-only link.

---

## 10. Four computers, four Claude Code instances

**Principle: contract-first, vertical ownership, no shared files.** Freeze section 6 schemas in Phase 0, then each machine works against mocks of the others.

### Repo layout (one monorepo, one owner per top-level directory)
```
/contracts          JSON Schema + validator (frozen; changes via PR to all)
/src/shared         Mozaik runtime, RunState, event names (Machine A)
/src/orchestrator   Machine A
/src/research       Machine B
/src/analysis       Machine C
/dashboard          Machine D (React + Vite)
/mocks              fixture data for every contract (Machine D curates)
/e2e                end-to-end harness (Machine D)
/config             models.json (single source of model IDs)
/docs               this plan, ADRs
CLAUDE.md           repo-wide rules; each owned dir has its own CLAUDE.md
```

### Workstreams
| Machine | Owns | Deliverables |
|---|---|---|
| **A: Core / Orchestration** | `/src/orchestrator`, `/src/shared`, `/contracts` | Task board, Topic Planner, Allocator and dynamic reassignment, budgets, run state, event bus, checkpoint/resume, API server (REST + SSE) |
| **B: Research agents** | `/src/research` | Scout, Collector, Analyst, Verifier; Tavily wrapper with caching and rate limits; source reliability scoring; prompt-injection hardening; produces `Finding`/`Source` |
| **C: Analysis & strategy** | `/src/analysis` | Financial Modeler, Build-vs-Buy, Risk/Red Team, Synthesizer; scenario engine; assumption registry; produces `Scenario`/`BusinessPlan` |
| **D: Dashboard & QA** | `/dashboard`, `/mocks`, e2e tests | UI, live feed, assumption editor, exports; fixtures; end-to-end test harness; demo script |

### Coordination rules
- **Branching**: trunk-based, short-lived branches `a/…`, `b/…`, `c/…`, `d/…`; PR required, CI must pass contract-validation. Nobody edits another machine's directory; request via issue/PR.
- **Contract changes**: additive only after Phase 0 (new optional fields). Breaking changes need all four to agree and a version bump.
- **Sync cadence**: integrate to `main` at least every few hours; shared `STATUS.md` (one section per machine, each edits only its own) updated at each push; a short blocker list at the top.
- **Each machine's CLAUDE.md** states: owned paths, contracts it consumes/produces, "do not touch" paths, test command, definition of done.
- **Secrets**: `.env` per machine, never committed; each machine uses its own Tavily/API key to avoid shared rate limits and to make cost attributable.
- **Shared environment pitfalls**: pin the Node version (22+); same lockfiles; same model IDs configured in one `config/models.json`; consistent timezone/currency handling.
- **Integration owner**: Machine D runs the nightly/hourly e2e on `main` and reports breakage to the owner.

### Phases
| Phase | Content | Gate |
|---|---|---|
| 0. Contracts & skeleton | A freezes schemas; D builds fixtures; repo, CI, CLAUDE.md files | All four can run against mocks |
| 1. Vertical slice | One company, 3 topics, 1 workflow end to end into a stub plan on the dashboard | Demo passes with real Tavily calls |
| 2. Dynamic allocation | Scout gate, drop/shallow/deep, reassignment, budgets | Provably reassigns agents in a seeded test run |
| 3. Analysis depth | Financial scenarios, build-vs-buy, red team, sensitivity | Plan numbers all trace to assumptions |
| 4. Hardening | Edge cases from section 8, failure injection, privacy, exports | Chaos test and 3 diverse sample companies pass |
| 5. Polish & demo | UX, narrative, docs | Rehearsed demo |

**If this is for a deadline of roughly one day** (e.g. the hackathon): cut to Phase 0 + 1 + a visible slice of 2 (dropping a topic and reassigning an agent live on the dashboard), simple 3-scenario financial model, build-vs-buy for one capability, and pre-cached research for the demo company as a fallback.

---

## 10b. Mozaik implementation

The system runs on `@mozaik-ai/core` 4.1: one shared runtime, every actor a *participant* that reacts to events. This replaces central orchestration with reaction, which is exactly what dynamic allocation needs.

| Plan concept | Mozaik construct |
|---|---|
| Task Board, budgets, run state | `RunState extends RuntimeState` (`src/shared/runtime.ts`) |
| Planner, Scout, Collector, Analyst, Verifier, Financial, Build-vs-Buy, Red Team, Synthesizer | `createAgent({ name, capabilities, instruction, tools, handlers })`, model from `config/models.json` |
| Allocator, Operator, Cartographer (dashboard bridge) | code-only participants via `createHuman({ handlers })` (no LLM) |
| Topic scored / dropped / assigned / finished | custom events (`EV.*` in `src/shared/events.ts`) via `sendEvent` |
| "Agent gets reassigned" | Allocator emits `task.assigned` for a stable **worker slot**; the worker spawns a fresh Agent for the new topic with a short handoff note, the old Agent `leave()`s |
| Per-topic budget enforcement | `InterceptionHandler` passed to `runLoop` rewrites the next transition |
| Tavily search/extract/map/crawl/research | `FunctionTool`s wrapping `@tavily/core` |
| Contract validation of LLM output | submit tools validate with Ajv and return readable errors so the model retries |
| Live agent view for free | Mozaik cloud (app.jigjoy.ai) streams runs automatically; custom dashboard uses the Cartographer SSE feed |

**Event flow (dynamic allocation)**
1. Planner emits `topics.proposed` -> human checkpoint -> `topic.approved`.
2. Allocator assigns Scout slots: `task.assigned`.
3. Scout runs, calls `report_scores` -> `topic.scored`.
4. Allocator applies the gate: drop (`topic.dropped`, slot freed -> `slot.idle`), shallow, or deep. Idle slots get the highest-priority topic via `task.assigned` (with `fromTopicId`).
5. Workers submit findings/sources -> `finding.submitted` / `source.submitted`; Verifier triggered for high-impact items.
6. When no open topics remain (or budget/time ends) the Allocator emits `analysis.requested`; analysis agents produce scenarios and `plan.ready`.

**Caveats to respect**
- `runLoop` and `sendMessage` are fire-and-forget; never `await` them in a processor.
- Fan-out does not await processors, so processors must be idempotent and tolerate out-of-order events.
- `initializeRuntime` throws if called twice; tests call `startRuntime` once per file.
- Keep allocator decisions as a pure function over state so they can be tested without the runtime.

---

## 11. Quality and evaluation
- **Golden companies**: 3–5 sample profiles with expected topic coverage; regression-test topic lists and key findings.
- **Metrics**: source coverage per claim, % verified high-impact findings, cost per run, time to plan, reassignment efficiency (agent-minutes spent on dropped topics), user rating.
- **Red-team tests**: injection pages, contradictory sources, empty search results, API outage, budget exhaustion.
- **Determinism aids**: temperature low for analysis/finance, schema-validated outputs with retry, numbers computed by code not by the LLM.

## 12. Key risks to the project itself
| Risk | Mitigation |
|---|---|
| Schema drift between machines | Contracts frozen, CI validation, additive changes only |
| LLM-made arithmetic errors | All math in deterministic code; LLM only chooses assumptions |
| Cost blowups | Per-topic and per-run budgets, caching, shallow-by-default |
| Integration surprises late | Vertical slice in Phase 1, hourly e2e on `main` |
| Over-confident recommendations | Confidence labels, ranges, "what would change this" section |

## 13. Open questions for the user
1. Who is the end user (founder, consultant, investor) and how technical?
2. Single-company runs or portfolio/multi-client?
3. Hosting for the dashboard and API (default: local run; stack is fixed: Node 22 + TypeScript + Mozaik, React dashboard)?
4. Budget per run (compute and search credits) and target runtime?
5. Is a deadline driving the scope cut in section 10?
