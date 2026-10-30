import { test } from "node:test"
import assert from "node:assert/strict"
import { IdGenerator, agentRef } from "./ids.ts"
import { RunState } from "../shared/runtime.ts"
import { validateContract } from "./validate.ts"

test("ids are sequential per prefix and resume after existing state", () => {
	const state = new RunState()
	state.sources.set("s_007", { id: "s_007" })
	state.findings.set("f_012", { id: "f_012" })
	const g = new IdGenerator(state)
	assert.equal(g.next("s"), "s_008")
	assert.equal(g.next("s"), "s_009")
	assert.equal(g.next("f"), "f_013")
})

test("slot ids that do not fit the contract id pattern are normalised", () => {
	assert.equal(agentRef("a_02"), "a_02")
	assert.equal(agentRef("slot_1"), "slot_1")
	assert.equal(agentRef("Slot-A"), "a_SlotA")
	assert.equal(agentRef("---"), "a_x")
	assert.match(agentRef("worker 3 / main"), /^[a-z]{1,4}_[A-Za-z0-9]+$/)
})

test("the contract validator gives readable messages", () => {
	const bad = validateContract("finding", { id: "f_1", extra: true })
	assert.equal(bad.ok, false)
	assert.ok(!bad.ok && bad.errors.some((e) => /required|additional/i.test(e)))
	assert.ok(!bad.ok && bad.errors.some((e) => e.includes("extra")))
})
