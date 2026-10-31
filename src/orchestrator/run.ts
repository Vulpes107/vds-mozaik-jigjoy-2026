// Starts one run: runtime, worker slots, the code-only participants, and (unless disabled) the Planner.
import { SemanticEvent } from "@mozaik-ai/core"
import { EV, type WorkerRole } from "../shared/events.ts"
import { join, sendEvent, startRuntime, type Budget, type Obj, type RunState } from "../shared/runtime.ts"
import { AnalysisSession, registerAnalysis } from "../analysis/index.ts"
import { startResearch, tavilyWithFallbacks, type FetchProvider, type ResearchExtras, type SearchProvider } from "../research/index.ts"
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
	/** Allocator clock period; 0 disables it (tests). */
	tickMs?: number
	/** Research workers: default Tavily from .env; pass providers to swap them, or false to run without research (tests). */
	research?: false | { searchProviders: SearchProvider[]; fetchProviders: FetchProvider[]; extras?: ResearchExtras }
}

/** Applied when the profile sets no run_budget: a run never spends without a cap. */
export const defaultRunBudget: Budget = { usd: 2, seconds: 1800 }

export const defaultSlots: Record<WorkerRole, number> = { scout: 2, collector: 1, analyst: 2, verifier: 1 }

export function startRun(profile: Obj, opts: RunOptions = {}): RunState {
	const err = validate("company_profile", profile)
	if (err) throw new Error(`invalid CompanyProfile:\n${err}`)
	const state = startRuntime(opts.runId ?? `r_${Date.now().toString(36)}`)
	state.profile = profile
	state.runBudget = { ...defaultRunBudget, ...(profile.run_budget as Budget | undefined) }
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

let rejectionHandlerInstalled = false
let producerId = ""

/** Dashboard edit of an assumption; analysis (C) recomputes scenarios and plan without an LLM. */
export function overrideAssumption(assumptionId: string, value: number | null): void {
	sendEvent(SemanticEvent.create(EV.AssumptionOverridden, producerId, { assumptionId, value }), producerId)
}

/** Dashboard "stop": the run ends now; the snapshot records it as `stopped`. */
export function stopRun(reason: string): void {
	sendEvent(SemanticEvent.create(EV.RunCompleted, producerId, { reason }), producerId)
}

function tavilyAsProviders() {
	// Tavily first, then free/accountless fallbacks (Parallel, You.com, Firecrawl) when Tavily is rate-limited/down.
	return tavilyWithFallbacks()
}

function joinParticipants(state: RunState, opts: RunOptions) {
	const cartographer = makeCartographer()
	join(cartographer)
	if (opts.snapshotDir !== null) {
		// Debounced: a burst of events writes once.
		let timer: NodeJS.Timeout | undefined
		onAgentEvent(() => {
			clearTimeout(timer)
			timer = setTimeout(() => {
				try {
					writeSnapshot(state, opts.snapshotDir ?? "data")
				} catch (e) {
					console.error(`snapshot of ${state.runId} failed (run continues, resume is not possible): ${String(e)}`) // e.g. a read-only data/mozaik.db
				}
			}, 200)
			timer.unref()
		})
	}
	join(makeOperator({ autoApprove: opts.autoApprove }))
	join(makeAllocator(opts.allocator ?? defaultConfig))
	join(makeMeter())
	producerId = cartographer.getId()
	if (opts.research !== false) {
		const providers = opts.research ?? tavilyAsProviders()
		startResearch({ state, ...providers, slots: [...state.slots.keys()], installSafetyNet: false })
	}
	registerAnalysis(new AnalysisSession(state))
	if (opts.tickMs !== 0) {
		setInterval(() => sendEvent(SemanticEvent.create(EV.AllocatorTick, cartographer.getId(), {}), cartographer.getId()), opts.tickMs ?? 10_000).unref()
	}
	// runLoop is fire-and-forget and Mozaik does not catch a failed agent loop; without this one
	// gateway error would take the whole process (API, SSE, run) down.
	if (!rejectionHandlerInstalled) {
		rejectionHandlerInstalled = true
		process.on("unhandledRejection", (e) => {
			console.error("agent loop failed:", e)
			// Before topics exist only the Planner runs, so its failure ends the run. Afterwards it is one worker's loop
			// (typically a retired agent's late transition: "Participant … not found" after a reassignment); the slot's
			// own task timeout reassigns it, so the run goes on.
			if (state.topics.size === 0) sendEvent(SemanticEvent.create(EV.RunCompleted, cartographer.getId(), { reason: `agent loop failed: ${e instanceof Error ? e.message : String(e)}` }), cartographer.getId())
		})
	}
	if (opts.planner !== false) startPlanner()
	sendEvent(SemanticEvent.create(EV.RunStarted, cartographer.getId(), { runId: state.runId }), cartographer.getId())
	return cartographer
}
