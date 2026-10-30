import { test } from "node:test"
import assert from "node:assert/strict"
import { SemanticEvent, SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV, type SpendRecordedPayload } from "../shared/events.ts"
import { join, sendEvent, startRuntime } from "../shared/runtime.ts"
import { makeAllocator } from "./allocator-participant.ts"
import { makeMeter, usdFor } from "./meter.ts"

class WhenType extends SituationSpecification {
	constructor(private readonly type: string) {
		super()
	}
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === this.type
	}
}
const tick = () => new Promise((r) => setTimeout(r, 10))

test("usd pricing", () => {
	assert.equal(usdFor("claude-haiku-4-5", 1_000_000, 0), 1)
	assert.equal(usdFor("claude-sonnet-4-6", 0, 1_000_000), 15)
	assert.equal(usdFor("mystery", 1_000_000, 0), 3)
})

test("meter turns inference usage into spend the allocator books against the run budget", async () => {
	const state = startRuntime("r_meter")
	state.runBudget = { usd: 0.01 }
	state.topics.set("t_1", { id: "t_1", state: "queued", importance_prior: 0.5 })
	const seen: string[] = []
	const spends: SpendRecordedPayload[] = []
	const fakeAgent = createHuman({
		name: "FakeAgent",
		capabilities: [],
		handlers: [
			{ specification: new WhenType(EV.SpendRecorded), processor: { apply: ({ event }) => void spends.push(event.payload as SpendRecordedPayload) } },
			{ specification: new WhenType(EV.BudgetExhausted), processor: { apply: ({ event }) => void seen.push(event.type) } },
		],
	})
	join(makeMeter())
	join(makeAllocator())
	join(fakeAgent)
	const id = fakeAgent.getId()
	sendEvent(SemanticEvent.create("inference.started", id, { loopId: "L1", model: "claude-sonnet-4-6" }), id)
	sendEvent(SemanticEvent.create("inference.completed", id, { loopId: "L1", tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } }), id)
	await tick()
	assert.equal(spends.length, 1)
	assert.equal(spends[0]!.model, "claude-sonnet-4-6")
	assert.equal(spends[0]!.tokens, 1500)
	assert.equal(state.spent.tokens, 1500)
	assert.ok(Math.abs(state.spent.usd - 0.0105) < 1e-9)
	assert.deepEqual(seen, [EV.BudgetExhausted]) // 0.0105 >= 0.01
})
