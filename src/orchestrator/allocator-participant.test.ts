import { test } from "node:test"
import assert from "node:assert/strict"
import { SemanticEvent, SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV, type TaskAssignedPayload, type TopicScoredPayload } from "../shared/events.ts"
import { join, sendEvent, startRuntime } from "../shared/runtime.ts"
import { defaultConfig } from "./allocator.ts"
import { makeAllocator } from "./allocator-participant.ts"

class WhenType extends SituationSpecification {
	constructor(private readonly type: string) {
		super()
	}
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === this.type
	}
}
const tick = () => new Promise((r) => setTimeout(r, 10))

test("allocator participant drops a scored topic and reassigns the slot over the runtime", async () => {
	const state = startRuntime("r_test")
	state.topics.set("t_1", { schema_version: "1.0", id: "t_1", run_id: "r_test", title: "a", category: "other", state: "queued", importance_prior: 0.9 })
	state.topics.set("t_2", { schema_version: "1.0", id: "t_2", run_id: "r_test", title: "b", category: "other", state: "queued", importance_prior: 0.5 })
	state.slots.set("scout_1", { role: "scout", topicId: null, assignedAt: 0, reassignments: 0 })

	const assigned: TaskAssignedPayload[] = []
	const dropped: string[] = []
	const scout = createHuman({
		name: "Scout",
		capabilities: [],
		handlers: [
			{ specification: new WhenType(EV.TaskAssigned), processor: { apply: ({ event }) => void assigned.push(event.payload as TaskAssignedPayload) } },
			{ specification: new WhenType(EV.TopicDropped), processor: { apply: ({ event }) => void dropped.push((event.payload as { topicId: string }).topicId) } },
		],
	})
	join(makeAllocator({ ...defaultConfig, minDwellMs: 0 }))
	join(scout)

	sendEvent(SemanticEvent.create(EV.TopicApproved, scout.getId(), {}), scout.getId())
	await tick()
	assert.equal(assigned[0]?.topicId, "t_1")

	const low: TopicScoredPayload = { topicId: "t_1", relevance: 0.1, impact: 0.9, rationale: "off-scope" }
	sendEvent(SemanticEvent.create(EV.TopicScored, scout.getId(), low), scout.getId())
	await tick()
	assert.deepEqual(dropped, ["t_1"])
	assert.equal(assigned[1]?.topicId, "t_2")
	assert.equal(assigned[1]?.fromTopicId, "t_1")
	assert.equal(state.topics.get("t_1")?.state, "dropped")
	assert.equal(state.slots.get("scout_1")?.topicId, "t_2")
})
