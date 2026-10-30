// Thin seam over sendEvent so stores and tools can be tested without a Mozaik runtime.
import { SemanticEvent } from "@mozaik-ai/core"
import { sendEvent } from "../shared/runtime.ts"

export interface Emitter {
	emit(type: string, payload: unknown): void
}

/** Events are sent as `producerId` (the stable slot worker / research participant, which stays joined). */
export function runtimeEmitter(producerId: string): Emitter {
	return {
		emit(type, payload) {
			sendEvent(SemanticEvent.create(type, producerId, payload), producerId)
		},
	}
}

/** Collects events in memory; used by tests and by dry runs. */
export class RecordingEmitter implements Emitter {
	readonly events: { type: string; payload: any }[] = []
	emit(type: string, payload: unknown): void {
		this.events.push({ type, payload })
	}
	ofType(type: string): any[] {
		return this.events.filter((e) => e.type === type).map((e) => e.payload)
	}
}
