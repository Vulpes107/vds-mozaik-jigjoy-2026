// Operator: bridges human checkpoints. v1 has one checkpoint, the topic list; approving it
// releases the board to the Allocator. `autoApprove` is for local demos and tests.
import { SemanticEvent, SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { resolveRuntime, sendEvent } from "../shared/runtime.ts"

export const TOPICS_CHECKPOINT = "cp_topics"

class WhenTopicsProposed extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === EV.TopicsProposed
	}
}

let operatorId = ""

export function makeOperator(opts: { autoApprove?: boolean } = {}) {
	const operator = createHuman({
		name: "Operator",
		capabilities: ["checkpoints"],
		handlers: [
			{
				specification: new WhenTopicsProposed(),
				processor: {
					apply: ({ participant }) => {
						const { checkpoints } = resolveRuntime().state
						// Follow-up rounds (replan) spend the budget the human already approved; only the initial agenda is a checkpoint.
						if (checkpoints.has(TOPICS_CHECKPOINT)) return
						checkpoints.set(TOPICS_CHECKPOINT, { id: TOPICS_CHECKPOINT, kind: "approve_topics", status: "pending", requested_at: new Date().toISOString() })
						sendEvent(SemanticEvent.create(EV.CheckpointRequested, participant.getId(), { id: TOPICS_CHECKPOINT, kind: "approve_topics" }), participant.getId())
						if (opts.autoApprove) resolveCheckpoint(TOPICS_CHECKPOINT, true)
					},
				},
			},
		],
	})
	operatorId = operator.getId()
	return operator
}

/** Resolve a pending checkpoint (from the API or autoApprove). Returns false if unknown or already resolved. */
export function resolveCheckpoint(id: string, approved: boolean): boolean {
	const producerId = operatorId
	const { checkpoints } = resolveRuntime().state
	const cp = checkpoints.get(id)
	if (!cp || cp.status !== "pending") return false
	cp.status = approved ? "approved" : "rejected"
	cp.resolved_at = new Date().toISOString()
	sendEvent(SemanticEvent.create(EV.CheckpointResolved, producerId, { id, approved }), producerId)
	if (id === TOPICS_CHECKPOINT) {
		if (approved) sendEvent(SemanticEvent.create(EV.TopicApproved, producerId, {}), producerId)
		else sendEvent(SemanticEvent.create(EV.RunCompleted, producerId, { reason: "topic list rejected" }), producerId)
	}
	return true
}
