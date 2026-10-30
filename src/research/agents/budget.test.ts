import { test } from "node:test"
import assert from "node:assert/strict"
import { createAgent } from "@mozaik-ai/core"
import { RecordingEmitter } from "../emitter.ts"
import { TaskScope } from "../task.ts"
import { TaskRun } from "./worker.ts"

const limits = { maxToolCalls: 5, maxTokens: 1000, seconds: 10, maxOutputTokens: 100 }
const agent = () => createAgent({ name: "x", capabilities: [], instruction: "", tools: [], handlers: [] })

test("a task stops at its next step once the run budget is exhausted, before its own limit", () => {
	const scope = new TaskScope("s1", "scout", "t_1", new RecordingEmitter())
	const run = { spent: { tokens: 0, calls: 0, usd: 0.5, seconds: 0 }, runBudget: { usd: 1 } }
	const r = new TaskRun(agent(), scope, limits, run)
	assert.equal(r.reason(), undefined)
	run.spent.usd = 1
	assert.equal(r.reason(), "run_budget")
	const own = new TaskRun(agent(), scope, limits)
	own.tokens = 1000
	assert.equal(own.reason(), "tokens")
})
