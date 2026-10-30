import { test } from "node:test"
import assert from "node:assert/strict"
import { RunState } from "../shared/runtime.ts"
import { createAnalysisTools } from "./tools.ts"
import { AnalysisSession } from "./session.ts"

function setup() {
	const state = new RunState()
	state.runId = "r_t"
	state.findings.set("f_001", { id: "f_001", topic_id: "t_001", claim: "Price is 100", type: "fact", value: 100, unit: "EUR", confidence: 0.8, verified: true })
	state.profile = { id: "p_1", financials: { cash_on_hand: 50000, monthly_burn: 5000 } }
	const session = new AnalysisSession(state, () => new Date("2026-10-30T12:00:00Z"))
	const tools = createAnalysisTools(session)
	const call = (name: string, args: unknown) => tools[name]!.invoke(args)
	return { state, session, call }
}

const upsert = (over: Record<string, unknown> = {}) => ({ text: "Price", unit: "EUR", low: 80, base: 100, high: 120, basis_finding_ids: ["f_001"], confidence: 0.8, ...over })

test("tools: upsert_assumption validates ranges and finding ids with fixable messages", async () => {
	const { call, state } = setup()
	await assert.rejects(call("upsert_assumption", upsert({ low: 120, high: 80 })), /low <= base <= high/)
	await assert.rejects(call("upsert_assumption", upsert({ basis_finding_ids: ["f_404"] })), /Unknown finding ids: f_404/)
	const ok = (await call("upsert_assumption", upsert())) as { id: string; origin: string }
	assert.equal(ok.id, "as_001")
	assert.equal(ok.origin, "research")
	assert.equal(state.assumptions.size, 1)
})

test("tools: unsupported assumptions are stored as defaults with capped confidence", async () => {
	const { call, state } = setup()
	const r = (await call("upsert_assumption", upsert({ basis_finding_ids: [], confidence: 0.95 }))) as { origin: string; confidence: number }
	assert.equal(r.origin, "default")
	assert.ok(r.confidence <= 0.4)
	assert.equal(state.assumptions.get("as_001")!.origin, "default")
})

test("tools: updating an assumption never discards the user's dashboard override", async () => {
	const { call, state } = setup()
	await call("upsert_assumption", upsert())
	state.assumptions.get("as_001")!.user_override = 90
	await call("upsert_assumption", upsert({ id: "as_001", base: 105 }))
	assert.equal(state.assumptions.get("as_001")!.user_override, 90)
	assert.equal(state.assumptions.get("as_001")!.base, 105)
})

const scenarioArgs = (over: Record<string, unknown> = {}) => ({
	id: "sc_nothing",
	name: "Do nothing",
	kind: "do_nothing",
	years: 2,
	discount_rate: 0.1,
	revenue: "as_001 * 1000",
	opex: "50000",
	...over,
})

test("tools: compute_scenario reports unknown assumptions, then works and stores 3 cases", async () => {
	const { call, state } = setup()
	await assert.rejects(call("compute_scenario", scenarioArgs()), /Assumption "as_001" does not exist/)
	await call("upsert_assumption", upsert())
	const r = (await call("compute_scenario", scenarioArgs())) as { scenario_id: string; base: { npv: number }; npv_adverse: number; npv_favourable: number }
	assert.equal(r.scenario_id, "sc_nothing")
	assert.ok(r.npv_adverse < r.base.npv && r.base.npv < r.npv_favourable)
	assert.deepEqual([...state.scenarios.keys()].sort(), ["sc_nothing", "sc_nothingHigh", "sc_nothingLow"])
})

test("tools: scenarios must be tied to assumptions; defaults come from the company profile", async () => {
	const { call, session } = setup()
	await call("upsert_assumption", upsert())
	await assert.rejects(call("compute_scenario", scenarioArgs({ revenue: "100000" })), /at least one assumption/)
	await call("compute_scenario", scenarioArgs())
	assert.equal(session.specs.get("sc_nothing")!.opening_cash, 50000) // cash_on_hand from the profile
	assert.equal(session.specs.get("sc_nothing")!.contingency_pct, 0) // baseline needs none
})

test("tools: assemble_plan needs a baseline; rejects prose citing unknown findings; then produces a valid plan", async () => {
	const { call, state } = setup()
	await call("upsert_assumption", upsert())
	await assert.rejects(call("assemble_plan", {}), /do_nothing/)
	await call("compute_scenario", scenarioArgs())
	await assert.rejects(call("assemble_plan", { recommendations: [{ title: "x", rationale: "y", confidence: 0.5, finding_ids: ["f_999"] }] }), /unknown finding ids: f_999/)
	assert.equal(state.plan, undefined) // nothing half-written
	const r = (await call("assemble_plan", { executive_summary: "Keep going." })) as { verdict: string }
	assert.equal(r.verdict, "continue")
	assert.ok(state.plan)
})

test("tools: compute_tco stores a result that appears in the plan", async () => {
	const { call, state } = setup()
	await call("upsert_assumption", upsert({ text: "Volume", unit: "units/month", low: 800, base: 1000, high: 1200 }))
	await call("compute_scenario", scenarioArgs({ revenue: "as_001 * 1000" }))
	const r = (await call("compute_tco", {
		capability: "Billing",
		horizon_years: 3,
		volume_per_month: "as_001",
		build: { dev_cost: 200000, variable_cost_per_unit: 0.5 },
		buy: { integration_cost: 10000, annual_license: 30000, variable_fee_per_unit: 2 },
		finding_ids: ["f_001"],
	})) as { verdict: string; flip_point: string }
	assert.equal(r.verdict, "buy")
	assert.match(r.flip_point, /wins above/)
	await call("assemble_plan", {})
	const plan = state.plan as unknown as { decisions: { build_vs_buy: { capability: string }[] } }
	assert.equal(plan.decisions.build_vs_buy[0]!.capability, "Billing")
})

test("tools: findings are exposed to the model as data only (no instruction fields beyond the claim text)", async () => {
	const { call } = setup()
	const r = (await call("list_findings", {})) as { count: number; findings: Record<string, unknown>[] }
	assert.equal(r.count, 1)
	assert.deepEqual(Object.keys(r.findings[0]!).sort(), ["as_of", "claim", "confidence", "id", "stale", "topic_id", "type", "unit", "value", "verified"].sort())
})
