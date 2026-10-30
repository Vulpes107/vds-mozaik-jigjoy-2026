# Machine C — Analysis & Strategy

You own `src/analysis/`. Read root `CLAUDE.md` and `docs/MASTERPLAN.md` §7, §8, §11 first.

## Mission
Turn the knowledge base (`Finding`s) into `Assumption`s, deterministic `Scenario`s, build-vs-buy verdicts, a risk register, and the final `BusinessPlan`.

## Produces
`Assumption`, `Scenario`, `BusinessPlan`.

## Consumes
`Finding`, `Source`, `CompanyProfile`, closed/dropped/unresolved `Topic` lists. Develop against `mocks/` first.

## Hard rule: numbers come from code
All arithmetic (NPV, IRR, payback, break-even, TCO, sensitivity, Monte Carlo) lives in tested pure functions in `src/analysis/engine/`. The LLM may only (1) select assumptions from findings with `basis_finding_ids`, and (2) write prose. Never let an LLM produce a financial figure directly. Scenario outputs must be reproducible from the stored assumptions.

## Modules
- **Assumption registry:** each assumption has low/base/high, unit, confidence, basis findings. Honour `user_override` from the dashboard; recomputation must be fast (<1s) so the UI can recalc live.
- **Financial Modeler:** scenarios `do_nothing` (always), `optimise`, `expand`, `pivot`, `exit`. Three cases (low/base/high). Bottom-up capex/opex, contingency 15–25%, staged `tranches` with `kill_criteria`. Metrics: NPV, IRR (null if undefined), payback, break-even, min cash balance, `runway_breached`. Tornado sensitivity on top 5 assumptions.
- **Build-vs-Buy:** per capability, 3–5 yr TCO for build / buy / partner (dev cost, maintenance, opportunity cost, time-to-market, licence fees, integration, lock-in, exit cost). Output verdict plus the **flip point**.
- **Risk & Red Team:** attack the draft: which assumption breaks the plan, concentration risk, regulation, cash runway vs payback, macro/FX, key-person, open-source licence contamination in the build option, vendor viability. Feed `risks[]`.
- **Synthesizer:** executive summary, ranked recommendations (each with `finding_ids`, confidence, `what_would_change_this`), decisions block, roadmap with gates, list `unresolved_topic_ids` and `dropped_topic_ids`.

## Honesty requirements
- If cash runway is shorter than payback, lead with the liquidity warning.
- Thin or conflicting evidence -> widen ranges, lower `overall_confidence`, say so in the summary. Never present illustrative figures as precise.
- Missing company financials -> mark as illustrative and list what input would sharpen the result.
- Always include the disclaimer (not legal, tax or financial advice).

## Tests you must have
Golden numeric tests for NPV/IRR/payback (hand-checked), TCO flip-point test, sensitivity ordering, `runway_breached` edge case, reproducibility (same inputs -> identical outputs), schema validation of every output, behaviour with empty/low-confidence findings.

## Do not touch
`src/orchestrator/`, `src/research/`, `dashboard/`, `contracts/` (request changes from A).

## Mozaik implementation (C)
- Pure TypeScript in `src/analysis/engine/` (no Mozaik imports, no LLM): npv, irr, payback, tco, sensitivity. Unit-test with `node:test`.
- LLM agents (`Financial`, `BuildBuy`, `RedTeam`, `Synthesizer`) are `createAgent` participants triggered by `EV.AnalysisRequested`. Their tools call the engine (`compute_scenario`, `compute_tco`, `run_sensitivity`) so the model supplies assumption ids and the code returns numbers.
- Use structured output (`InferenceInput.structuredOutput`) for the `BusinessPlan`, then validate with Ajv before emitting `EV.PlanReady`.
- Recompute path for the dashboard's assumption editor must not call an LLM: engine only. It is triggered by `EV.AssumptionOverridden`.
- Fixtures to develop against: `mocks/assumption.sample.json`, `mocks/scenario.sample.json`, `mocks/business_plan.sample.json`.

## Status and wiring (C)
```ts
const state = startRuntime("r_xxx")          // A: src/shared/runtime.ts (fill state.profile / findings / topics first)
const session = new AnalysisSession(state)
registerAnalysis(session)                    // joins the Conductor and the Recomputer
sendEvent(SemanticEvent.create(EV.AnalysisRequested, joinedId, {}), joinedId)   // runs financial -> buildbuy -> synthesizer
// result: state.assumptions / state.scenarios / state.plan; events scenario.computed + plan.ready
```
- Dashboard edit: send `EV.AssumptionOverridden { assumptionId, value | null }`; scenarios and plan are rebuilt by the engine only (no LLM, < 1 s).
- Scenario specs use formulas over assumption ids (`as_001 * as_002 * (1 + as_003) ^ (year - 1)`); parsed by a safe evaluator, never `eval`. "low"/"high" cases mean adverse/favourable per assumption (cost drivers are inverted automatically).
- `npm test` includes `analysis.flow.test.ts` (scripted fake model, real runtime) and `analysis.timeout.test.ts` (hung model -> fallback plan).

## Mozaik gotchas learned (read before touching participants)
1. **The loop runs only the first function call of each model turn**; parallel calls are dropped. Agent prompts say "one tool per turn".
2. **Never `leave()` an agent while its loop may still publish.** The loop re-resolves its agent after every event; leaving inside a `model.answer` handler throws. Leave on the next tick (`setImmediate`), and never leave a hung agent.
3. Tools signal errors by throwing; Mozaik hands the message to the model as `Error calling tool: ...`. Keep messages fixable.
4. Fan-out is not awaited and runs synchronously per consumer: handlers must be idempotent and must not throw.

## Known limits
- Prose supplied by the model (executive summary, recommendations) is validated for finding ids but **not** scanned for invented numbers; the prompts forbid them and the plan appends the computed figures.
- Option scores and risk likelihood/severity are heuristics; labelled as such in the output.
- IRR uses one bracketed root; indicative when cash flows change sign repeatedly.
- Not yet exercised against a live model (no API keys in CI); the fake-model tests prove the wiring, not prompt quality.
