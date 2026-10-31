// Pure session behaviour (no runtime, no model).
import { test } from "node:test"
import assert from "node:assert/strict"
import { RunState } from "../shared/runtime.ts"
import { assertValid } from "./contracts.ts"
import { AnalysisSession } from "./session.ts"

test("ensureBaseline: no do_nothing scenario from the model -> illustrative baseline from the profile, plan still assembles", () => {
	const state = new RunState()
	state.runId = "r_base"
	state.profile = { id: "p_1", name: "X", currency: "EUR", horizon_years: 2, financials: { annual_revenue: 1_800_000, monthly_burn: 140_000, cash_on_hand: 300_000 } }
	const session = new AnalysisSession(state, () => new Date("2026-10-30T12:00:00Z"))

	assert.equal(session.recompute(), null) // nothing to assemble yet
	assert.equal(session.ensureBaseline(), true)
	assert.equal(session.ensureBaseline(), false) // idempotent
	assert.equal(state.assumptions.size, 2)
	for (const a of state.assumptions.values()) assert.equal(a.origin, "default")
	const out = session.recompute()
	assert.ok(out)
	assertValid("business_plan", out.plan)
	assert.ok(state.plan)
	assert.equal(out.scenarios.find((s) => s.id === "sc_baseline")?.kind, "do_nothing")
})

test("ensureBaseline: a profile without financials still yields a valid (zero) baseline", () => {
	const state = new RunState()
	state.runId = "r_base0"
	state.profile = { id: "p_2", name: "X" }
	const session = new AnalysisSession(state)
	assert.equal(session.ensureBaseline(), true)
	assert.ok(session.recompute())
})
