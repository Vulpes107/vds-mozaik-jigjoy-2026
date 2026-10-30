// Starts one run: runtime, worker slots, the code-only participants, and (unless disabled) the Planner.
import { SemanticEvent } from "@mozaik-ai/core"
import { EV, type WorkerRole } from "../shared/events.ts"
import { join, sendEvent, startRuntime, type Obj, type RunState } from "../shared/runtime.ts"
import { validate } from "../shared/validate.ts"
import { makeAllocator } from "./allocator-participant.ts"
import { defaultConfig, type AllocatorConfig } from "./allocator.ts"
import { makeCartographer } from "./cartographer.ts"
import { makeOperator } from "./operator.ts"
import { startPlanner } from "./planner.ts"

export interface RunOptions {
	runId?: string
	autoApprove?: boolean
	/** Worker slots per role. Slot ids are `a_<role prefix><n>` so they satisfy the contract id pattern. */
	slots?: Partial<Record<WorkerRole, number>>
	allocator?: AllocatorConfig
	/** Set false in tests to avoid the LLM call. */
	planner?: boolean
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
	const cartographer = makeCartographer()
	join(cartographer)
	join(makeOperator({ autoApprove: opts.autoApprove }))
	join(makeAllocator(opts.allocator ?? defaultConfig))
	if (opts.planner !== false) startPlanner()
	sendEvent(SemanticEvent.create(EV.RunStarted, cartographer.getId(), { runId: state.runId }), cartographer.getId())
	return state
}
