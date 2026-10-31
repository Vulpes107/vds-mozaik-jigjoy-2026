import { test } from "node:test"
import assert from "node:assert/strict"
import { assertValid } from "../contracts.ts"
import { assemblePlan, DISCLAIMER, type PlanInput } from "./plan.ts"
import { computeTco } from "./tco.ts"
import type { Assumption, ScenarioSpec } from "./types.ts"

const NOW = new Date("2026-10-30T12:00:00Z")

const A = (id: string, text: string, unit: string, low: number, base: number, high: number, extra: Partial<Assumption> = {}): Assumption => ({
	schema_version: "1.0",
	id,
	run_id: "r_t",
	text,
	unit,
	low,
	base,
	high,
	origin: "research",
	confidence: 0.8,
	basis_finding_ids: ["f_001"],
	...extra,
})

const assumptions = (): Assumption[] => [
	A("as_001", "Price per unit", "EUR", 80, 100, 120),
	A("as_002", "Units per year", "units", 900, 1000, 1100),
	A("as_003", "Operating cost per year", "EUR", 40000, 50000, 60000),
]

const baseSpec = (over: Partial<ScenarioSpec> = {}): ScenarioSpec => ({
	id: "sc_nothing",
	name: "Do nothing",
	kind: "do_nothing",
	currency: "EUR",
	years: 2,
	discount_rate: 0,
	contingency_pct: 0,
	opening_cash: 100000,
	revenue: "as_001 * as_002 * 0.7",
	opex: "as_003 * 0.7",
	...over,
})

const expandSpec = (over: Partial<ScenarioSpec> = {}): ScenarioSpec => ({
	id: "sc_expand",
	name: "Expand",
	kind: "expand",
	currency: "EUR",
	years: 2,
	discount_rate: 0,
	contingency_pct: 0,
	opening_cash: 100000,
	revenue: "as_001 * as_002",
	opex: "as_003",
	capex: "24000",
	...over,
})

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
	runId: "r_t",
	now: NOW,
	assumptions: assumptions(),
	specs: [baseSpec(), expandSpec()],
	findings: [{ id: "f_001" }],
	topics: [],
	buildBuy: [],
	...over,
})

const validateAll = (out: ReturnType<typeof assemblePlan>, assumps: Assumption[] = assumptions()) => {
	assertValid("business_plan", out.plan)
	for (const s of out.scenarios) assertValid("scenario", s)
	for (const a of assumps) assertValid("assumption", a)
}

test("plan: schema-valid, expand wins, break point names the assumption and value", () => {
	const out = assemblePlan(input())
	validateAll(out)
	assert.equal(out.plan.decisions.continue_vs_change.verdict, "expand")
	assert.equal(out.plan.chosen_scenario_id, "sc_expand")
	assert.equal(out.scenarios.length, 6) // 2 specs x low/base/high
	assert.deepEqual(out.plan.scenario_ids.sort(), ["sc_expand", "sc_expandHigh", "sc_expandLow", "sc_nothing", "sc_nothingHigh", "sc_nothingLow"].sort())
	// Plan stops beating doing nothing at price 90 (hand-solved).
	const bp = out.breakpoints.find((b) => b.assumption_id === "as_001")
	assert.ok(bp && Math.abs(bp.value - 90) < 1e-3, JSON.stringify(bp))
	assert.match(out.plan.recommendations[0]!.what_would_change_this!, /Price per unit below 90/)
	assert.ok(out.plan.risks.some((r) => r.id === "rk_fragilePlan"))
	assert.equal(out.plan.disclaimer, DISCLAIMER)
	assert.deepEqual(out.plan.assumption_ids, ["as_001", "as_002", "as_003"])
})

test("plan: liquidity warning leads the summary and the recommendations", () => {
	const out = assemblePlan(
		input({
			assumptions: assumptions(),
			specs: [
				baseSpec({ opening_cash: 3000, revenue: "as_001 * as_002 * 0.7" }),
				expandSpec({
					opening_cash: 3000,
					revenue: "as_001 * as_002 * 1.5",
					opex: "as_003 * 1.2",
					capex: undefined,
					contingency_pct: 20,
					tranches: [
						{ amount: "10000", month: 0, kill_criteria: ["Fewer than 20 paying pilots"] },
						{ amount: "14000", month: 6, kill_criteria: ["CAC above 1200"] },
					],
				}),
			],
			profile: { financials: { cash_on_hand: 3000, monthly_burn: 1500 } },
		}),
	)
	validateAll(out)
	assert.equal(out.plan.decisions.continue_vs_change.verdict, "expand")
	assert.ok(out.plan.executive_summary.startsWith("LIQUIDITY WARNING"), out.plan.executive_summary)
	assert.equal(out.plan.recommendations[0]!.title, "Secure liquidity before committing capital")
	assert.equal(out.plan.recommendations[0]!.rank, 1)
	assert.equal(out.plan.risks[0]!.id, "rk_liquidity")
	const chosen = out.scenarios.find((s) => s.id === "sc_expand")!
	assert.equal(chosen.metrics.runway_breached, true)
	// Staged investment, gate reviews the previous tranche's kill criteria.
	assert.equal(out.plan.decisions.investment.staged, true)
	assert.equal(out.plan.decisions.investment.base, 28800) // 24,000 * 1.2
	assert.deepEqual(out.plan.roadmap.map((r) => [r.month, r.gate]), [[0, false], [6, true]])
	assert.deepEqual(out.plan.roadmap[1]!.kill_criteria, ["Fewer than 20 paying pilots"])
})

test("plan: no findings -> low confidence and an explicit 'illustrative' caveat", () => {
	const weak = assumptions().map((a) => ({ ...a, origin: "default" as const, confidence: 0.4, basis_finding_ids: [] }))
	const out = assemblePlan(input({ assumptions: weak, findings: [] }))
	validateAll(out, weak)
	assert.ok(out.plan.overall_confidence < 0.5, String(out.plan.overall_confidence))
	assert.match(out.plan.executive_summary, /illustrative/)
	assert.match(out.plan.executive_summary, /confidence is low/)
	assert.ok(out.plan.risks.some((r) => r.id === "rk_weakEvidence"))
	assert.ok(out.plan.risks.some((r) => r.id === "rk_dataGap")) // no company financials
})

test("plan: unresolved and dropped topics are disclosed but do not lower confidence", () => {
	const clean = assemblePlan(input())
	const out = assemblePlan(
		input({
			topics: [
				{ id: "t_001", state: "closed" },
				{ id: "t_002", state: "dropped" },
				{ id: "t_003", state: "research_incomplete" },
				{ id: "t_004", state: "deep" },
				{ id: "t_005", state: "shallow" },
			],
		}),
	)
	validateAll(out)
	assert.deepEqual(out.plan.unresolved_topic_ids, ["t_003", "t_004"])
	assert.deepEqual(out.plan.dropped_topic_ids, ["t_002"])
	assert.equal(out.plan.overall_confidence, clean.plan.overall_confidence)
	assert.ok(out.plan.risks.some((r) => r.id === "rk_evidenceGap"))
})

test("plan: a bad option loses; 'continue' needs no capital and gets a review roadmap", () => {
	const out = assemblePlan(input({ specs: [baseSpec(), expandSpec({ id: "sc_bad", capex: "500000" })] }))
	validateAll(out)
	assert.equal(out.plan.decisions.continue_vs_change.verdict, "continue")
	assert.deepEqual(out.plan.decisions.investment, { currency: "EUR", low: 0, base: 0, high: 0, staged: false, rationale: "No new capital is required to continue as is." })
	assert.equal(out.plan.roadmap.at(-1)!.month, 12)
})

test("plan: risk appetite changes the weighting", () => {
	// Aggressive expansion: higher base value, worse downside. The weighting must differ by appetite.
	const specs = [baseSpec(), expandSpec({ revenue: "as_001 * as_002 * 1.4", opex: "as_003 * 1.4", capex: "60000" })]
	const low = assemblePlan(input({ specs, profile: { risk_appetite: "low" } }))
	const high = assemblePlan(input({ specs, profile: { risk_appetite: "high" } }))
	assert.notDeepEqual(low.plan.decisions.continue_vs_change.scores, high.plan.decisions.continue_vs_change.scores)
	// Expand has the higher base value but the worse downside, so a larger value weight (high appetite) must favour it more.
	const gap = (p: typeof low) => p.plan.decisions.continue_vs_change.scores.expand! - p.plan.decisions.continue_vs_change.scores.continue!
	assert.ok(gap(high) > gap(low), `gap high ${gap(high)} vs low ${gap(low)}`)
})

test("plan: build-vs-buy flows into decisions and risks, schema-valid", () => {
	const tco = computeTco(
		{
			capability: "Billing",
			horizon_years: 3,
			volume_per_month: "as_002",
			build: { dev_cost: 200000, variable_cost_per_unit: 0.5 },
			buy: { integration_cost: 10000, annual_license: 30000, variable_fee_per_unit: 2 },
		},
		assumptions(),
	)
	const out = assemblePlan(input({ buildBuy: [{ ...tco, candidate_vendors: ["Vendor A"], finding_ids: ["f_001"] }] }))
	validateAll(out)
	const bb = out.plan.decisions.build_vs_buy[0]!
	assert.equal(bb.capability, "Billing")
	assert.equal(bb.verdict, "buy")
	assert.equal(bb.tco_build, tco.build.total)
	assert.ok(out.plan.risks.some((r) => r.id === "rk_vendorLock1"))
	assert.ok(out.plan.recommendations.some((r) => r.title === "Buy Billing"))
})

test("plan: narrative prose is accepted if its findings exist, rejected otherwise", () => {
	const ok = assemblePlan(
		input({
			narrative: {
				executive_summary: "Market growth supports a staged expansion.",
				recommendations: [{ title: "Expand in stages", rationale: "Because growth.", confidence: 0.6, finding_ids: ["f_001"] }],
			},
		}),
	)
	validateAll(ok)
	assert.match(ok.plan.executive_summary, /Market growth supports a staged expansion\./)
	assert.equal(ok.plan.recommendations[0]!.title, "Expand in stages")
	assert.throws(
		() =>
			assemblePlan(
				input({ narrative: { recommendations: [{ title: "x", rationale: "y", confidence: 0.5, finding_ids: ["f_999"] }] } }),
			),
		/unknown finding ids: f_999/,
	)
})

test("plan: deterministic for identical inputs; baseline is mandatory", () => {
	assert.deepEqual(assemblePlan(input()), assemblePlan(input()))
	assert.throws(() => assemblePlan(input({ specs: [expandSpec()] })), /do_nothing/)
})

test("plan: recompute after a dashboard override is fast (< 1s) and changes the numbers", () => {
	const before = assemblePlan(input())
	const pinned = assumptions().map((a) => (a.id === "as_001" ? { ...a, user_override: 85 } : a))
	const t0 = performance.now()
	const after = assemblePlan(input({ assumptions: pinned }))
	const ms = performance.now() - t0
	assert.ok(ms < 1000, `took ${ms}ms`)
	assert.notEqual(
		before.scenarios.find((s) => s.id === "sc_expand")!.metrics.npv,
		after.scenarios.find((s) => s.id === "sc_expand")!.metrics.npv,
	)
	// Price pinned at 85 (< 90 break-even): doing nothing should now be preferred or at least score the plan lower.
	assert.ok(after.plan.decisions.continue_vs_change.scores.expand! < before.plan.decisions.continue_vs_change.scores.expand!)
})
