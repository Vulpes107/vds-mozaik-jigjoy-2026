import { test } from "node:test"
import assert from "node:assert/strict"
import { SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { join, resolveRuntime, startRuntime, type Slot } from "../shared/runtime.ts"
import { CATEGORIES, MAX_TOPICS, makeSubmitTopics, replanCap, roundSummary, topicCap } from "./planner.ts"

class WhenProposed extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === EV.TopicsProposed
	}
}

const good = CATEGORIES.map((category, i) => ({ title: `T${i} ${category}`, question: `Q${i}?`, category, importance_prior: 0.5 }))

test("submit_topics validates against the contract and writes the board", async () => {
	const state = startRuntime("r_test")
	const proposed: unknown[] = []
	const watcher = createHuman({ name: "W", capabilities: [], handlers: [{ specification: new WhenProposed(), processor: { apply: ({ event }) => void proposed.push(event.payload) } }] })
	join(watcher)
	const tool = makeSubmitTopics(() => watcher.getId())

	let res = await tool.invoke({ topics: good.slice(0, 5), skipped_categories: [] })
	assert.equal(res.status, "invalid")
	assert.ok(res.errors.some((e: string) => e.includes("at least 10")))
	assert.ok(res.errors.some((e: string) => e.includes("category 'ip'")))
	assert.equal(state.topics.size, 0)

	res = await tool.invoke({ topics: [...good.slice(0, 14), { ...good[14]!, importance_prior: 7 }], skipped_categories: [{ category: "cyber_ops", reason: "n/a" }] })
	assert.equal(res.status, "invalid")
	assert.match(res.errors[0], /topics\[14\].*importance_prior/)

	res = await tool.invoke({ topics: good, skipped_categories: [] })
	assert.equal(res.status, "invalid")
	assert.ok(res.errors.some((e: string) => e.includes("at most 15")))

	res = await tool.invoke({ topics: [...good.slice(0, 14), { ...good[14]!, depends_on: [good[0]!.title] }], skipped_categories: [{ category: "cyber_ops", reason: "n/a" }] })
	assert.equal(res.status, "ok")
	assert.equal(state.topics.size, 15)
	assert.equal(state.topics.get("t_001")?.state, "queued")
	assert.deepEqual(state.topics.get("t_015")?.depends_on, ["t_001"])
	await new Promise((r) => setTimeout(r, 10))
	assert.equal(proposed.length, 1)
})

test("topicCap: the research share of money and time, and the collector/analyst/verifier trios, bound the agenda", () => {
	const slot = (role: Slot["role"]): Slot => ({ role, topicId: null, assignedAt: 0, reassignments: 0 })
	const one = [slot("scout"), slot("scout"), slot("collector"), slot("analyst"), slot("verifier")]
	assert.equal(topicCap({ usd: 3, seconds: 900 }, one), 6) // money: 2.25 USD / 0.3 = 7; time: 660 s / 100 = 6 trio-topics
	assert.equal(topicCap({ usd: 4, seconds: 3600 }, one), 10) // money: 3/0.3 = 10; time: 2700/100 = 27
	assert.equal(topicCap({ usd: 1, seconds: 300 }, one), 3) // floor of 3
	assert.equal(topicCap({ usd: 100, seconds: 36_000 }, one), MAX_TOPICS)
	assert.equal(topicCap({}, one), MAX_TOPICS)
})

test("submit_topics enforces the run's own bounds", async () => {
	const tool = makeSubmitTopics(() => "p", { min: 3, max: 3 })
	const res = await tool.invoke({ topics: good.slice(0, 5), skipped_categories: CATEGORIES.slice(5).map((c) => ({ category: c, reason: "n/a" })) })
	assert.equal(res.status, "invalid")
	assert.ok(res.errors.some((e: string) => e.includes("at most 3")))
})

test("replanCap: leftover research budget in whole topics, no floor", () => {
	const slot = (role: Slot["role"]): Slot => ({ role, topicId: null, assignedAt: 0, reassignments: 0 })
	const one = [slot("collector"), slot("analyst"), slot("verifier")]
	assert.equal(replanCap({ usd: 1 }, one), 3)
	assert.equal(replanCap({ usd: 0.2 }, one), 0)
	assert.equal(replanCap({ usd: 1, seconds: 160 }, one), 1)
})

test("a replan round appends to the board: ids continue, duplicates by title are skipped, coverage is not required, empty is fine", async () => {
	const state = resolveRuntime().state // one runtime per process: reuse the first test's
	state.topics.clear()
	const proposed: unknown[] = []
	const watcher = createHuman({ name: "W", capabilities: [], handlers: [{ specification: new WhenProposed(), processor: { apply: ({ event }) => void proposed.push(event.payload) } }] })
	join(watcher)
	const first = makeSubmitTopics(() => watcher.getId(), { min: 1, max: 2 })
	assert.equal((await first.invoke({ topics: good.slice(0, 2), skipped_categories: CATEGORIES.slice(2).map((c) => ({ category: c, reason: "n/a" })) })).status, "ok")

	const tool = makeSubmitTopics(() => watcher.getId(), { min: 0, max: 2 }, 1)
	let res = await tool.invoke({ topics: [good[0]!, { ...good[5]!, title: "Follow-up", depends_on: [good[0]!.title] }], skipped_categories: [] })
	assert.equal(res.status, "ok")
	assert.equal(res.count, 1)
	assert.equal(state.topics.size, 3)
	assert.deepEqual(state.topics.get("t_003")?.depends_on, ["t_001"])
	res = await tool.invoke({ topics: [], skipped_categories: [] })
	assert.equal(res.status, "ok")
	assert.equal(state.topics.size, 3)
	await new Promise((r) => setTimeout(r, 10))
	assert.deepEqual(proposed.map((p) => (p as { topicIds: string[]; round: number }).round), [0, 1, 1])
	assert.deepEqual((proposed[2] as { topicIds: string[] }).topicIds, [])

	const summary = roundSummary(state.topics.values(), [{ id: "f_1", topic_id: "t_001", claim: "A claim", confidence: 0.7 }])
	assert.match(summary, /^- \[t_001\] T0 market — queued\n {4}- A claim \(confidence 0.7\)\n- \[t_002\]/)
})
