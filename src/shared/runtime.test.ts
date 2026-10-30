import { test } from "node:test"
import assert from "node:assert/strict"
import { SemanticEvent, SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV, type TopicScoredPayload } from "./events.ts"
import { join, sendEvent, startRuntime } from "./runtime.ts"

class WhenTopicScored extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === EV.TopicScored
	}
}

test("custom events reach joined participants", async () => {
	startRuntime("r_test")
	const seen: TopicScoredPayload[] = []

	const allocator = createHuman({
		name: "Allocator",
		capabilities: [],
		handlers: [{ specification: new WhenTopicScored(), processor: { apply: ({ event }) => void seen.push(event.payload as TopicScoredPayload) } }],
	})
	const scout = createHuman({ name: "Scout", capabilities: [], handlers: [] })
	join(allocator)
	join(scout)

	const payload: TopicScoredPayload = { topicId: "t_001", relevance: 0.1, impact: 0.1, rationale: "unrelated region" }
	sendEvent(SemanticEvent.create(EV.TopicScored, scout.getId(), payload), scout.getId())

	// Fan-out is asynchronous with respect to the sender; yield once.
	await new Promise((r) => setTimeout(r, 10))
	assert.equal(seen.length, 1)
	assert.equal(seen[0]?.topicId, "t_001")
})
