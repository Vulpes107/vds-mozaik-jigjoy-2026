import { test } from "node:test"
import assert from "node:assert/strict"
import { allocationAt, cashCurve, droppedAt, firstBelowZero, groupScenarios } from "./derive.ts"
import type { AgentEvent, Scenario, Topic } from "./types/contracts.ts"

const ev = (o: Partial<AgentEvent>): AgentEvent => ({ schema_version: "1.0", ts: "2026-10-30T10:00:00Z", run_id: "r_1", type: "agent_idle", ...o }) as AgentEvent
const events = [
	ev({ seq: 41, type: "topic_dropped", agent_id: "a_03", agent_role: "scout", topic_id: "t_002" }),
	ev({ seq: 42, type: "agent_reassigned", agent_id: "a_03", from_topic_id: "t_002", topic_id: "t_001" }),
]
const topics = [{ id: "t_001", assigned_agents: ["a_01"] }, { id: "t_002", assigned_agents: [] }] as unknown as Topic[]

test("allocation replays from any scrubber position, including before the first event", () => {
	assert.equal(allocationAt(events, topics, 0).find((a) => a.id === "a_03")!.topicId, "t_002")
	assert.equal(allocationAt(events, topics, 1).find((a) => a.id === "a_03")!.topicId, "t_002")
	assert.equal(allocationAt(events, topics, 2).find((a) => a.id === "a_03")!.topicId, "t_001")
	assert.equal(allocationAt(events, topics, 2).find((a) => a.id === "a_01")!.topicId, "t_001", "unmentioned agents keep topic placement")
})
test("dropped topics appear only after their event", () => {
	assert.equal(droppedAt(events, 0).size, 0)
	assert.ok(droppedAt(events, 1).has("t_002"))
})
const sc = (o: Partial<Scenario>): Scenario => ({ schema_version: "1.0", id: "sc_1", run_id: "r_1", name: "x", kind: "expand", currency: "EUR", capex: 0, revenue_by_year: [120000], opex_by_year: [0], assumption_ids: ["as_001"], ...o }) as Scenario
test("cash curve: even monthly flow, tranche capex with contingency, first month below zero", () => {
	const c = cashCurve(sc({ revenue_by_year: [120000], opex_by_year: [60000], tranches: [{ amount: 50000, month: 0, kill_criteria: [] }], contingency_pct: 20 }), 20000)
	assert.equal(c[0]!.cash, 20000 - 60000) // 50k * 1.2 released at month 0
	assert.equal(c[12]!.cash, -40000 + 60000)
	assert.equal(firstBelowZero(c), 0)
	assert.equal(firstBelowZero(cashCurve(sc({ opex_by_year: [0] }), 0)), null)
})
test("groupScenarios collects low/high cases next to the base case", () => {
	const g = groupScenarios([sc({ id: "a" }), sc({ id: "aLow", case: "low" }), sc({ id: "aHigh", case: "high" }), sc({ id: "b", kind: "exit", name: "Exit" })])
	assert.equal(g.length, 2)
	assert.equal(g[0]!.low!.id, "aLow")
	assert.equal(g[1]!.low, undefined)
})
