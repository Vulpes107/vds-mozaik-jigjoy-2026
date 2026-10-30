// Per-task scope: who is working on which topic, plus counters the worker needs to decide how the task ended.
import { EV, type ResearchGapPayload, type WorkerRole } from "../shared/events.ts"
import type { Emitter } from "./emitter.ts"
import { agentRef } from "./ids.ts"
import type { CallContext } from "./types.ts"

export class TaskScope implements CallContext {
	readonly agentRef: string
	readonly counters = { findings: 0, sources: 0, searches: 0, searchesOk: 0, fetches: 0, fetchesOk: 0, toolCalls: 0, suggestions: 0, scoresReported: 0, verifications: 0 }
	readonly gaps: string[] = []
	cancelled = false

	constructor(
		readonly slotId: string,
		readonly role: WorkerRole,
		readonly topicId: string,
		private readonly emitter: Emitter,
		readonly category?: string,
		readonly depth?: "shallow" | "deep",
	) {
		this.agentRef = agentRef(slotId)
	}

	/** One ResearchGap event per distinct reason per task; the Allocator decides whether to mark research_incomplete. */
	recordGap(reason: string): void {
		if (this.gaps.includes(reason)) return
		this.gaps.push(reason)
		const payload: ResearchGapPayload = { topicId: this.topicId, slotId: this.slotId, reason }
		this.emitter.emit(EV.ResearchGap, payload)
	}

	emit(type: string, payload: unknown): void {
		this.emitter.emit(type, payload)
	}
}
