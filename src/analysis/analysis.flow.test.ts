// End-to-end through the REAL Mozaik runtime with a scripted fake model (no API keys, no network):
// AnalysisRequested -> financial -> build-vs-buy -> synthesizer -> validated plan; then a dashboard override recomputes
// without any LLM call. One runtime per test file (initializeRuntime throws if called twice).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
	FunctionCallItem,
	ModelMessageItem,
	SemanticEvent,
	createHuman,
	type InferenceInput,
	type InferenceRunner,
} from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { RunState, initializeRuntime, join, sendEvent } from "../shared/runtime.ts"
import { assertValid } from "./contracts.ts"
import { registerAnalysis } from "./participants.ts"
import { AnalysisSession } from "./session.ts"

type Step = { call: { name: string; args: unknown } } | { text: string }
const call = (name: string, args: unknown): Step => ({ call: { name, args } })

const script: Record<string, Step[]> = {
	financial: [
		call("upsert_assumption", { text: "Price per unit", unit: "EUR", low: 80, base: 100, high: 120, basis_finding_ids: ["f_001"], confidence: 0.8 }),
		call("upsert_assumption", { text: "Units per year", unit: "units", low: 900, base: 1000, high: 1100, basis_finding_ids: ["f_001"], confidence: 0.7 }),
		call("upsert_assumption", { text: "Operating cost per year", unit: "EUR", low: 40000, base: 50000, high: 60000, basis_finding_ids: ["f_001"], confidence: 0.7 }),
		call("compute_scenario", { id: "sc_nothing", name: "Do nothing", kind: "do_nothing", years: 2, discount_rate: 0, revenue: "as_004 * as_005 * 0.7", opex: "as_006 * 0.7" }),
		call("compute_scenario", {
			id: "sc_expand",
			name: "Expand",
			kind: "expand",
			years: 2,
			discount_rate: 0,
			contingency_pct: 20,
			revenue: "as_004 * as_005 * 1.5",
			opex: "as_006 * 1.2",
			tranches: [
				{ amount: 10000, month: 0, kill_criteria: ["Fewer than 20 paying pilots"] },
				{ amount: 14000, month: 6, kill_criteria: ["CAC above 1200"] },
			],
		}),
		{ text: "Scenarios computed." },
	],
	buildbuy: [
		call("compute_tco", {
			capability: "Billing",
			horizon_years: 3,
			volume_per_month: "as_005",
			build: { dev_cost: 8000 }, // the scale guard allows at most 10x the profile's 3,000 cash
			buy: { integration_cost: 500, annual_license: 1500, variable_fee_per_unit: 0.1 },
			candidate_vendors: ["Vendor A"],
			finding_ids: ["f_001"],
		}),
		{ text: "Build vs buy done." },
	],
	synthesizer: [
		call("assemble_plan", { recommended_scenario_id: "sc_nothing", executive_summary: "x" }), // against the engine: rejected, then corrected
		call("assemble_plan", {
			recommended_scenario_id: "sc_expand",
			executive_summary: "Evidence supports a staged expansion.",
			risks: [{ title: "Churn among pilots", likelihood: 0.5, severity: 0.6, mitigation: "Monthly cohort review.", finding_ids: ["f_001"] }],
			recommendations: [{ title: "Expand in two tranches", rationale: "Keeps downside capped.", confidence: 0.6, finding_ids: ["f_001"], category: "strategy" }],
		}),
		{ text: "Plan assembled." },
	],
}

const steps: Record<string, number> = { financial: 0, buildbuy: 0, synthesizer: 0 }
let llmCalls = 0

const roleOf = (input: InferenceInput) =>
	input.tools?.some((t) => t.name === "compute_scenario") ? "financial" : input.tools?.some((t) => t.name === "compute_tco") ? "buildbuy" : "synthesizer"

const fakeRunner: InferenceRunner = {
	async run(input) {
		llmCalls++
		const role = roleOf(input)
		const idx = steps[role]!++
		const s = script[role]![idx]
		if (!s) throw new Error(`script for ${role} exhausted at step ${idx}`)
		const item = "call" in s ? FunctionCallItem.rehydrate({ callId: `c_${role}_${idx}`, name: s.call.name, args: JSON.stringify(s.call.args) }) : ModelMessageItem.rehydrate({ text: s.text })
		return { items: [item], tokenUsage: undefined, rowResponse: {} }
	},
	async *stream() {
		throw new Error("streaming not used")
	},
}

const state = new RunState()
state.runId = "r_flow"
state.profile = { id: "p_1", name: "Demo", financials: { cash_on_hand: 3000, monthly_burn: 1500 }, risk_appetite: "medium" }
state.findings.set("f_001", { id: "f_001", topic_id: "t_001", claim: "Comparable price is 100 EUR", type: "fact", confidence: 0.8, verified: true })
state.topics.set("t_001", { id: "t_001", state: "closed" })
state.topics.set("t_002", { id: "t_002", state: "dropped" })
initializeRuntime({ state, inferenceRunnerConfig: { runner: fakeRunner } })

const session = new AnalysisSession(state, () => new Date("2026-10-30T12:00:00Z"))
const logs: string[] = []
registerAnalysis(session, { stageTimeoutMs: 5000, log: (m) => logs.push(m) })

const trigger = createHuman({ name: "Allocator", capabilities: [], handlers: [] })
join(trigger)

async function until(cond: () => boolean, what: string, ms = 5000) {
	const t0 = Date.now()
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}. logs: ${logs.join(" | ")}`)
		await new Promise((r) => setTimeout(r, 10))
	}
}

const npv = (id: string) => (state.scenarios.get(id)!.metrics as { npv: number }).npv

test("analysis chain: three agents run in order and produce a valid plan", async () => {
	sendEvent(SemanticEvent.create(EV.AnalysisRequested, trigger.getId(), {}), trigger.getId())
	await until(() => state.plan !== undefined, "plan")

	assertValid("business_plan", state.plan)
	for (const s of state.scenarios.values()) assertValid("scenario", s)
	for (const a of state.assumptions.values()) assertValid("assumption", a)

	const plan = state.plan as any
	assert.equal(plan.decisions.continue_vs_change.verdict, "expand")
	assert.ok(plan.executive_summary.startsWith("LIQUIDITY WARNING"), plan.executive_summary)
	assert.match(plan.executive_summary, /Evidence supports a staged expansion\./)
	assert.equal(plan.recommendations[0].title, "Secure liquidity before committing capital")
	assert.ok(plan.recommendations.some((r: any) => r.title === "Expand in two tranches"))
	assert.equal(plan.decisions.build_vs_buy[0].capability, "Billing")
	assert.deepEqual(plan.dropped_topic_ids, ["t_002"])
	assert.ok(plan.risks.some((r: any) => r.id === "rk_n1" && r.title === "Churn among pilots"), "narrative risk merged")
	assert.equal(state.scenarios.size, 6)
	assert.equal(state.assumptions.size, 6) // 3 seeded from the profile + 3 from the model
	assert.equal(state.assumptions.get("as_002")!.origin, "user") // monthly burn stated in the profile
	assert.ok(plan.assumption_ids.every((id: string) => typeof state.assumptions.get(id)!.sensitivity_rank === "number"), "sensitivity ranks written back")
	assert.equal(state.assumptions.get("as_003")!.sensitivity_rank, undefined) // the unused investable-budget placeholder moves nothing

	// Scripts fully consumed: 6 + 2 + 2 model turns; agents cleaned up after themselves.
	assert.deepEqual(steps, { financial: 6, buildbuy: 2, synthesizer: 3 })
	await until(() => state.getParticipants().length === 3, "agents to leave") // trigger + conductor + recomputer
})

test("dashboard override recomputes scenarios and plan with NO model call, and can be cleared", async () => {
	const before = npv("sc_expand")
	const callsBefore = llmCalls
	const sender = trigger.getId()

	sendEvent(SemanticEvent.create(EV.AssumptionOverridden, sender, { assumptionId: "as_004", value: 70 }), sender)
	await until(() => state.assumptions.get("as_004")!.user_override === 70 && npv("sc_expand") !== before, "recompute")
	assert.ok(npv("sc_expand") < before, "lower price lowers expand NPV")
	assert.equal(llmCalls, callsBefore, "override path must not call the model")
	assertValid("business_plan", state.plan)

	sendEvent(SemanticEvent.create(EV.AssumptionOverridden, sender, { assumptionId: "as_004", value: null }), sender)
	await until(() => state.assumptions.get("as_004")!.user_override === null && npv("sc_expand") === before, "override cleared")
	assert.equal(llmCalls, callsBefore)
})

test("bad overrides are ignored safely", async () => {
	const sender = trigger.getId()
	const planBefore = JSON.stringify(state.plan)
	sendEvent(SemanticEvent.create(EV.AssumptionOverridden, sender, { assumptionId: "as_999", value: 5 }), sender)
	sendEvent(SemanticEvent.create(EV.AssumptionOverridden, sender, { assumptionId: "as_004", value: Number.NaN }), sender)
	await new Promise((r) => setTimeout(r, 50))
	assert.equal(JSON.stringify(state.plan), planBefore)
	assert.ok(logs.some((l) => l.includes("unknown assumption as_999")))
	assert.ok(logs.some((l) => l.includes("not a number")))
})
