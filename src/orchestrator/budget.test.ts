import { test } from "node:test"
import assert from "node:assert/strict"
import type { ExecutableTransition } from "@mozaik-ai/core"
import { startRuntime } from "../shared/runtime.ts"
import { budgetInterceptor, exhaustedLine } from "./budget.ts"

test("exhaustedLine", () => {
	assert.equal(exhaustedLine({ calls: 3 }, { calls: 5 }), null)
	assert.equal(exhaustedLine({ calls: 5 }, { calls: 5 }), "calls")
	assert.equal(exhaustedLine({ usd: 1 }, {}), null)
	assert.equal(exhaustedLine(undefined, { tokens: 1 }), null)
})

test("interceptor rewrites the next inference to a final message once the topic budget is gone", async () => {
	const state = startRuntime("r_budget")
	state.topics.set("t_1", { id: "t_1", state: "deep", importance_prior: 0.5, budget: { calls: 2 }, spent: { calls: 1 } })
	const h = budgetInterceptor("t_1")
	const inference = { nextStateId: "inference", input: {} } as unknown as ExecutableTransition
	assert.equal(h.isSatisfiedBy(inference), false)
	assert.equal(h.isSatisfiedBy({ nextStateId: "model_message", input: {} } as unknown as ExecutableTransition), false)

	state.topics.get("t_1")!.spent = { calls: 2 }
	assert.equal(h.isSatisfiedBy(inference), true)
	const t = await h.handle(inference)
	assert.equal(t.nextStateId, "model_message")
	assert.match((t.input as { answer: { content: { text: string } } }).answer.content.text, /topic calls/)

	state.topics.get("t_1")!.spent = { calls: 0 }
	state.runBudget = { usd: 1 }
	state.spent.usd = 1
	assert.equal(h.isSatisfiedBy(inference), true) // run-level budget also stops it
})
