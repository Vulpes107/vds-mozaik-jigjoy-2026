import { test } from "node:test"
import assert from "node:assert/strict"
import { SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { join, startRuntime } from "../shared/runtime.ts"
import { CATEGORIES, makeSubmitTopics } from "./planner.ts"

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
	assert.ok(res.errors.some((e: string) => e.includes("at least 15")))
	assert.ok(res.errors.some((e: string) => e.includes("category 'ip'")))
	assert.equal(state.topics.size, 0)

	res = await tool.invoke({ topics: [...good.slice(0, 15), { ...good[15]!, importance_prior: 7 }], skipped_categories: [] })
	assert.equal(res.status, "invalid")
	assert.match(res.errors[0], /topics\[15\].*importance_prior/)

	res = await tool.invoke({ topics: [...good.slice(0, 15), { ...good[15]!, depends_on: [good[0]!.title] }], skipped_categories: [] })
	assert.equal(res.status, "ok")
	assert.equal(state.topics.size, 16)
	assert.equal(state.topics.get("t_001")?.state, "queued")
	assert.deepEqual(state.topics.get("t_016")?.depends_on, ["t_001"])
	await new Promise((r) => setTimeout(r, 10))
	assert.equal(proposed.length, 1)
})
