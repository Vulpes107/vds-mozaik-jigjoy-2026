// Thin Mozaik shell around allocate(): listens to worker events, mutates RunState, emits the resulting events.
import { SemanticEvent, SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { resolveRuntime, sendEvent } from "../shared/runtime.ts"
import { allocate, defaultConfig, type AllocatorConfig, type Board } from "./allocator.ts"

const INPUTS = new Set<string>([
	EV.TopicApproved,
	EV.TopicScored,
	EV.TaskFinished,
	EV.SlotIdle,
	EV.TopicProgress,
	EV.ResearchGap,
	EV.ReassignmentRequested,
	EV.SpendRecorded,
])

class WhenWorkerEvent extends SituationSpecification {
	isSatisfiedBy({ event, participant }: SituationContext): boolean {
		return INPUTS.has(event.type) && event.producerId !== participant.getId()
	}
}

export function makeAllocator(cfg: AllocatorConfig = defaultConfig) {
	return createHuman({
		name: "Allocator",
		capabilities: ["allocation"],
		handlers: [
			{
				specification: new WhenWorkerEvent(),
				processor: {
					apply: ({ event, participant }) => {
						// RunState.topics holds contract objects; the allocator reads/writes the Topic fields it knows.
						const board = resolveRuntime().state as unknown as Board
						for (const { type, ...payload } of allocate(board, event, cfg)) {
							sendEvent(SemanticEvent.create(type, participant.getId(), payload), participant.getId())
						}
					},
				},
			},
		],
	})
}
