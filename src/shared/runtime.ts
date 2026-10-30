// The single Mozaik runtime for the whole system. Import the functions from here;
// never call defineRuntime/initializeRuntime anywhere else (it throws if initialised twice).
import { defineRuntime, RuntimeState } from "@mozaik-ai/core"

/** Contract objects are plain JSON validated against /contracts; typed loosely here until types are generated. */
export type Obj = Record<string, unknown> & { id: string }

export interface Budget {
	tokens?: number
	calls?: number
	usd?: number
	seconds?: number
}

export interface Slot {
	role: "scout" | "collector" | "analyst" | "verifier"
	topicId: string | null
	/** ms epoch of the current assignment (anti-thrash dwell time). */
	assignedAt: number
	reassignments: number
}

/** Shared store every participant reads/writes. Only the owning machine mutates its own collections. */
export class RunState extends RuntimeState {
	runId = ""
	profile?: Obj
	/** Owned by Machine A (orchestrator). */
	topics = new Map<string, Obj>()
	/** Owned by Machine B (research). */
	findings = new Map<string, Obj>()
	sources = new Map<string, Obj>()
	/** Owned by Machine C (analysis). */
	assumptions = new Map<string, Obj>()
	scenarios = new Map<string, Obj>()
	plan?: Obj
	/** Worker slots; Allocator is the only writer. Slot ids are stable, agents are disposable. */
	slots = new Map<string, Slot>()
	runBudget: Budget = {}
	spent: Required<Budget> = { tokens: 0, calls: 0, usd: 0, seconds: 0 }
}

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
	defineRuntime<RunState>()

/** Call once at process start (or once per test file). */
export function startRuntime(runId: string): RunState {
	const state = new RunState()
	state.runId = runId
	initializeRuntime({ state })
	return state
}
