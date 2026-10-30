// Starts one run: runtime, worker slots, the code-only participants, and (unless disabled) the Planner.
import { SemanticEvent } from "@mozaik-ai/core"
import { EV, type WorkerRole } from "../shared/events.ts"
import { join, sendEvent, startRuntime, type Obj, type RunState } from "../shared/runtime.ts"
import { validate } from "../shared/validate.ts"
import { makeAllocator } from "./allocator-participant.ts"
import { defaultConfig, type AllocatorConfig } from "./allocator.ts"
import { makeCartographer, onAgentEvent } from "./cartographer.ts"
import { makeMeter } from "./meter.ts"
import { makeOperator } from "./operator.ts"
import { startPlanner } from "./planner.ts"
import { readSnapshot, restore, writeSnapshot } from "./snapshot.ts"

export interface RunOptions {
	runId?: string
	autoApprove?: boolean
	/** Worker slots per role. Slot ids are `a_<role prefix><n>` so they satisfy the contract id pattern. */
	slots?: Partial<Record<WorkerRole, number>>
	allocator?: AllocatorConfig
	/** Set false in tests to avoid the LLM call. */
	planner?: boolean
	/** Snapshot directory; null disables snapshots (tests). */
	snapshotDir?: string | null
}

export const defaultSlots: Record<WorkerRole, number> = { scout: 2, collector: 1, analyst: 2, verifier: 1 }

export function startRun(profile: Obj, opts: RunOptions = {}): RunState {
	const err = validate("company_profile", profile)
	if (err) throw new Error(`invalid CompanyProfile:\n${err}`)
	const state = startRuntime(opts.runId ?? `r_${Date.now().toString(36)}`)
	state.profile = profile
	state.runBudget = (profile.run_budget as RunState["runBudget"]) ?? {}
	for (const [role, n] of Object.entries({ ...defaultSlots, ...opts.slots }) as [WorkerRole, number][]) {
		for (let i = 1; i <= n; i++) state.slots.set(`a_${role.slice(0, 2)}${i}`, { role, topicId: null, assignedAt: 0, reassignments: 0 })
	}
	joinParticipants(state, opts)
	return state
}

/** Resume a crashed run from its snapshot. Slots start idle; if the topic list was approved the Allocator refills them. */
export function resumeRun(runId: string, opts: RunOptions = {}): RunState {
	const dir = opts.snapshotDir ?? "data"
	const state = restore(startRuntime(runId), readSnapshot(runId, dir))
	const cartographer = joinParticipants(state, { ...opts, planner: state.topics.size === 0 && opts.planner !== false })
	if (state.checkpoints.get("cp_topics")?.status === "approved") {
		sendEvent(SemanticEvent.create(EV.TopicApproved, cartographer.getId(), {}), cartographer.getId())
	}
	return state
}

function joinParticipants(state: RunState, opts: RunOptions) {
	const cartographer = makeCartographer()
	join(cartographer)
	if (opts.snapshotDir !== null) {
		// Debounced: a burst of events writes once.
		let timer: NodeJS.Timeout | undefined
		onAgentEvent(() => {
			clearTimeout(timer)
			timer = setTimeout(() => writeSnapshot(state, opts.snapshotDir ?? "data"), 200)
			timer.unref()
		})
	}
	join(makeOperator({ autoApprove: opts.autoApprove }))
	join(makeAllocator(opts.allocator ?? defaultConfig))
	join(makeMeter())
	if (opts.planner !== false) startPlanner()
	sendEvent(SemanticEvent.create(EV.RunStarted, cartographer.getId(), { runId: state.runId }), cartographer.getId())
	return cartographer
}
