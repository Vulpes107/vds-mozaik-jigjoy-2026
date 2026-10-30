// A hung model must not hang the run: stages time out, the stuck agent is parked (not removed mid-loop),
// and a deterministic plan is still produced from whatever was computed. Separate file = separate runtime.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ModelMessageItem, SemanticEvent, createHuman, type InferenceRunner } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { RunState, initializeRuntime, join, sendEvent } from "../shared/runtime.ts"
import { assertValid } from "./contracts.ts"
import { registerAnalysis } from "./participants.ts"
import { AnalysisSession } from "./session.ts"
import type { ScenarioSpec } from "./engine/types.ts"

let synthesizerCalls = 0
const runner: InferenceRunner = {
	async run(input) {
		const isSynth = input.tools?.some((t) => t.name === "assemble_plan")
		if (isSynth) {
			synthesizerCalls++
			return new Promise(() => {}) // never answers
		}
		return { items: [ModelMessageItem.rehydrate({ text: "nothing to do" })], tokenUsage: undefined, rowResponse: {} }
	},
	async *stream() {
		throw new Error("unused")
	},
}

const state = new RunState()
state.runId = "r_timeout"
state.profile = { id: "p_1", financials: { cash_on_hand: 100000, monthly_burn: 1000 } }
state.findings.set("f_001", { id: "f_001", claim: "x", type: "fact", confidence: 0.8 })
for (const [id, text, low, base, high] of [
	["as_001", "Price", 80, 100, 120],
	["as_002", "Units", 900, 1000, 1100],
	["as_003", "Cost", 40000, 50000, 60000],
] as const) {
	state.assumptions.set(id, { schema_version: "1.0", id, run_id: "r_timeout", text, unit: "x", low, base, high, origin: "research", confidence: 0.7, basis_finding_ids: ["f_001"] })
}
initializeRuntime({ state, inferenceRunnerConfig: { runner } })

const session = new AnalysisSession(state, () => new Date("2026-10-30T12:00:00Z"))
const spec = (over: Partial<ScenarioSpec>): ScenarioSpec => ({
	id: "sc_nothing", name: "Do nothing", kind: "do_nothing", currency: "EUR", years: 2, discount_rate: 0,
	contingency_pct: 0, opening_cash: 100000, revenue: "as_001 * as_002 * 0.7", opex: "as_003 * 0.7", ...over,
})
session.computeSpec(spec({}))
session.computeSpec(spec({ id: "sc_expand", name: "Expand", kind: "expand", revenue: "as_001 * as_002", opex: "as_003", capex: "24000" }))

const logs: string[] = []
registerAnalysis(session, { stageTimeoutMs: 100, log: (m) => logs.push(m) })
const trigger = createHuman({ name: "Allocator", capabilities: [], handlers: [] })
join(trigger)

test("hung synthesizer: stage times out, agent is parked, fallback plan is still produced and valid", async () => {
	sendEvent(SemanticEvent.create(EV.AnalysisRequested, trigger.getId(), {}), trigger.getId())
	const t0 = Date.now()
	while (!state.plan) {
		if (Date.now() - t0 > 4000) throw new Error(`no fallback plan. logs: ${logs.join(" | ")}`)
		await new Promise((r) => setTimeout(r, 20))
	}
	assertValid("business_plan", state.plan)
	assert.equal(synthesizerCalls, 1)
	assert.ok(logs.some((l) => l.includes("synthesizer abandoned (timeout)")), logs.join(" | "))
	// The parked synthesizer is still joined (removing it mid-loop would crash Mozaik's loop when it finally returns).
	assert.ok(state.getParticipants().some((p) => p.getManifest().name === "Analysis-synthesizer"))
	// Plan content is the deterministic fallback (no narrative): contains computed verdict text.
	assert.match(String(state.plan!.executive_summary), /Recommended direction:/)
})
