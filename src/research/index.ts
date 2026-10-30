// Entry point of Machine B. `startResearch` wires providers -> gateway -> store -> slot workers into the shared
// Mozaik runtime (call it after `startRuntime` and after RunState.profile is set). Machine A's Allocator then
// drives everything by sending EV.TaskAssigned for slot ids registered here.
import { type Human, createHuman } from "@mozaik-ai/core"
import type { WorkerRole } from "../shared/events.ts"
import { type Obj, type RunState, join } from "../shared/runtime.ts"
import { type ResearchDeps } from "./agents/context.ts"
import { createSlotWorker } from "./agents/worker.ts"
import { type ContentStore, FileContentStore } from "./content.ts"
import { type Emitter, runtimeEmitter } from "./emitter.ts"
import { IdGenerator } from "./ids.ts"
import { type ModelConfig, loadModels } from "./models.ts"
import type { TaskLimits } from "./prompts.ts"
import { SourceLibrary } from "./sources.ts"
import { ResearchStore } from "./store.ts"
import { type CacheStore, FileCache, LayeredCache } from "./tools/cache.ts"
import { ResearchGateway, type GatewayLimits } from "./tools/gateway.ts"
import type { FetchProvider, ResearchExtras, SearchProvider } from "./tools/provider.ts"
import { LiveRedactor } from "./tools/redact.ts"
import { RateLimiter, type RetryPolicy, defaultRetry } from "./tools/resilience.ts"
import { CallBudget, UsageMeter } from "./tools/usage.ts"
import { type Clock, systemClock } from "./types.ts"

export interface ResearchOptions {
	state: RunState
	searchProviders: SearchProvider[]
	fetchProviders: FetchProvider[]
	extras?: ResearchExtras
	/** Worker slots to register. A number creates slot ids slot_1..slot_n; or pass the Allocator's own ids. */
	slots: number | string[]
	models?: ModelConfig
	cache?: CacheStore
	content?: ContentStore
	clock?: Clock
	/** Replace the event emitter (tests). Defaults to sending Mozaik events as the research participant. */
	emitter?: Emitter
	/** Extra confidential terms that are not in the profile (e.g. customer names). */
	confidentialTerms?: string[]
	/** Exchange rates to the profile currency; without a rate, foreign amounts stay in their own currency. */
	fxRates?: Record<string, number>
	retry?: () => RetryPolicy
	limiter?: RateLimiter
	gatewayLimits?: Partial<GatewayLimits>
	limitsFor?: ResearchDeps["limitsFor"]
	/** Log unhandled promise rejections instead of letting a failed LLM call crash the process. Default true. */
	installSafetyNet?: boolean
}

export interface ResearchSystem {
	deps: ResearchDeps
	workers: Human[]
	bus: Human
	meter: UsageMeter
	budget: CallBudget
}

/** Default hard limits per task; Topic.budget.tokens / .seconds from the orchestrator override them. */
export function defaultLimits(role: WorkerRole, depth: "shallow" | "deep", topic: Obj): TaskLimits {
	const deep = depth === "deep"
	const base: Record<WorkerRole, TaskLimits> = {
		scout: { maxToolCalls: 5, maxTokens: 30_000, seconds: 90, maxOutputTokens: 1024 },
		// Tokens include the re-sent context of every turn (and cached tokens): 60k on Sonnet is about $0.20 per task.
		collector: { maxToolCalls: deep ? 10 : 6, maxTokens: deep ? 60_000 : 40_000, seconds: deep ? 300 : 150, maxOutputTokens: 2048 },
		analyst: { maxToolCalls: deep ? 12 : 8, maxTokens: deep ? 80_000 : 50_000, seconds: deep ? 360 : 200, maxOutputTokens: 4096 },
		verifier: { maxToolCalls: deep ? 10 : 6, maxTokens: deep ? 60_000 : 40_000, seconds: deep ? 300 : 200, maxOutputTokens: 2048 },
	}
	const limits = { ...base[role] }
	const b = topic.budget as { tokens?: number; seconds?: number } | undefined
	if (b?.tokens) limits.maxTokens = b.tokens
	if (b?.seconds) limits.seconds = b.seconds
	return limits
}

let safetyNetInstalled = false
function installSafetyNet(): void {
	if (safetyNetInstalled) return
	safetyNetInstalled = true
	// Mozaik runs loops fire-and-forget: a failed inference call (bad key, 400, network) becomes an unhandled
	// rejection. The slot's task timeout turns that into a TaskFinished(timeout) + ResearchGap; here we only make
	// sure it is logged rather than killing every other worker.
	process.on("unhandledRejection", (reason) => {
		console.error("[research] unhandled rejection (worker task will end by timeout):", reason instanceof Error ? reason.message : reason)
	})
}

export function startResearch(opts: ResearchOptions): ResearchSystem {
	const { state } = opts
	const clock = opts.clock ?? systemClock
	if (opts.installSafetyNet !== false) installSafetyNet()

	// A stable, joined participant that produces B's events (workers come and go, this stays).
	const bus = createHuman({ name: "ResearchBus", capabilities: ["research"], handlers: [] })
	join(bus)
	const emitter = opts.emitter ?? runtimeEmitter(bus.getId())

	const ids = new IdGenerator(state)
	const library = new SourceLibrary({ state, ids, clock, content: opts.content ?? new FileContentStore(), emitter })
	const store = new ResearchStore({ state, ids, library, emitter, clock, ...(opts.fxRates ? { fxRates: opts.fxRates } : {}) })

	const budget = new CallBudget({
		topicCalls: (id) => (state.topics.get(id)?.budget as { calls?: number } | undefined)?.calls,
		runCalls: () => state.runBudget.calls,
	})
	const meter = new UsageMeter()
	const gateway = new ResearchGateway({
		searchProviders: opts.searchProviders,
		fetchProviders: opts.fetchProviders,
		...(opts.extras ? { extras: opts.extras } : {}),
		cache: new LayeredCache(opts.cache ?? new FileCache("data/cache/web")),
		redactor: new LiveRedactor(() => state.profile, opts.confidentialTerms),
		library,
		meter,
		budget,
		limiter: opts.limiter ?? new RateLimiter({ maxConcurrent: 4, minIntervalMs: 150 }),
		retry: opts.retry ?? defaultRetry,
		clock,
		...(opts.gatewayLimits ? { limits: opts.gatewayLimits } : {}),
	})

	const deps: ResearchDeps = {
		state,
		gateway,
		store,
		library,
		emitter,
		producerId: bus.getId(),
		models: opts.models ?? loadModels(),
		clock,
		limitsFor: opts.limitsFor ?? defaultLimits,
	}

	const slotIds = typeof opts.slots === "number" ? Array.from({ length: opts.slots }, (_, i) => `slot_${i + 1}`) : opts.slots
	const workers = slotIds.map((id) => createSlotWorker(id, deps))
	for (const w of workers) join(w)
	return { deps, workers, bus, meter, budget }
}

export * from "./tools/provider.ts"
export { tavilyProviders, createTavilyClient } from "./tools/tavily.ts"
