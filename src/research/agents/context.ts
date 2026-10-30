// Shared wiring for the worker factories.
import type { Obj, RunState } from "../../shared/runtime.ts"
import type { WorkerRole } from "../../shared/events.ts"
import type { Emitter } from "../emitter.ts"
import type { ModelConfig } from "../models.ts"
import type { TaskLimits } from "../prompts.ts"
import type { SourceLibrary } from "../sources.ts"
import type { ResearchStore } from "../store.ts"
import type { TaskScope } from "../task.ts"
import type { ResearchGateway } from "../tools/gateway.ts"
import type { Clock } from "../types.ts"

export interface ResearchDeps {
	state: RunState
	gateway: ResearchGateway
	store: ResearchStore
	library: SourceLibrary
	emitter: Emitter
	/** Participant id used as the producer of B's events (a joined, stable participant). */
	producerId: string
	models: ModelConfig
	clock: Clock
	/** Per-role task limits; overridden by Topic.budget when A sets one. */
	limitsFor(role: WorkerRole, depth: "shallow" | "deep", topic: Obj): TaskLimits
}

export interface WorkerContext {
	deps: ResearchDeps
	scope: TaskScope
	topic: Obj
}
