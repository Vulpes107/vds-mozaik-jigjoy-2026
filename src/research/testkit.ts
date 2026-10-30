// Test helpers for Machine B: scripted providers, a fixed clock, and a fully in-memory harness.
import { RunState, type Obj } from "../shared/runtime.ts"
import { MemoryContentStore } from "./content.ts"
import { RecordingEmitter } from "./emitter.ts"
import { IdGenerator } from "./ids.ts"
import { SourceLibrary } from "./sources.ts"
import { ResearchStore } from "./store.ts"
import { TaskScope } from "./task.ts"
import { MemoryCache } from "./tools/cache.ts"
import { ResearchGateway, type GatewayLimits } from "./tools/gateway.ts"
import {
	type FetchOptions,
	type FetchProvider,
	type FetchResult,
	ProviderError,
	type SearchOptions,
	type SearchProvider,
	type SearchResult,
} from "./tools/provider.ts"
import { LiveRedactor } from "./tools/redact.ts"
import { RateLimiter, type RetryPolicy } from "./tools/resilience.ts"
import { CallBudget, UsageMeter, type CallLimits } from "./tools/usage.ts"
import type { Clock } from "./types.ts"

export const NOW = new Date("2026-10-30T12:00:00Z")
export const fixedClock: Clock = { now: () => NOW }

export const profile = (): Obj =>
	({
		id: "profile",
		schema_version: "1.0",
		name: "Demo Logistics d.o.o.",
		description: "Regional last-mile delivery company considering software for route optimisation.",
		industry: "Logistics",
		countries: ["RS", "HR", "BA"],
		currency: "EUR",
		products: [
			{ name: "Express Delivery", description: "Same-day parcel delivery", stage: "mature", annual_revenue: 1800000, annual_cost: 1650000 },
			{ name: "RouteGenius", description: "Unreleased routing engine", stage: "prototype" },
		],
		financials: { annual_revenue: 1800000, monthly_burn: 140000, cash_on_hand: 300000, investable_budget: 150000 },
		goals: ["Improve margin", "Reduce delivery time below four hours"],
		notes: "We are quietly negotiating an acquisition of Bravo Couriers next quarter. [private]Project Falcon is the codename[/private]",
	}) as Obj

export type SearchScript = (query: string, opts: SearchOptions | undefined, call: number) => SearchResult[] | Promise<SearchResult[]>
export type FetchScript = (url: string, opts: FetchOptions | undefined, call: number) => FetchResult | Promise<FetchResult>

export class FakeSearch implements SearchProvider {
	calls: { query: string; opts?: SearchOptions }[] = []
	constructor(
		readonly name: string,
		private readonly script: SearchScript = () => [],
	) {}
	async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
		this.calls.push({ query, ...(opts ? { opts } : {}) })
		return this.script(query, opts, this.calls.length)
	}
}

export class FakeFetch implements FetchProvider {
	calls: string[] = []
	batches: string[][] = []
	constructor(
		readonly name: string,
		private readonly script: FetchScript = (url) => page(url, "text"),
		readonly batching = false,
	) {
		if (batching) {
			this.fetchMany = async (urls: string[], opts?: FetchOptions) => {
				this.batches.push(urls)
				return Promise.all(urls.map((u) => this.fetch(u, opts)))
			}
		}
	}
	fetchMany?: (urls: string[], opts?: FetchOptions) => Promise<FetchResult[]>
	async fetch(url: string, opts?: FetchOptions): Promise<FetchResult> {
		this.calls.push(url)
		return this.script(url, opts, this.calls.length)
	}
}

export const page = (url: string, text: string, extra: Partial<FetchResult> = {}): FetchResult => ({
	url,
	title: "Page",
	text,
	status: 200,
	fetchedAt: NOW.toISOString(),
	...extra,
})

export const outage = (): ProviderError => new ProviderError("unavailable", "503 Service Unavailable")

export const fastRetry = (attempts = 3): (() => RetryPolicy) => () => ({ attempts, baseMs: 1, maxMs: 2, sleep: async () => {}, random: () => 0 })

export interface Harness {
	state: RunState
	emitter: RecordingEmitter
	library: SourceLibrary
	store: ResearchStore
	gateway: ResearchGateway
	meter: UsageMeter
	budget: CallBudget
	content: MemoryContentStore
	cache: MemoryCache
	scope(role?: "scout" | "collector" | "analyst" | "verifier", topicId?: string, depth?: "shallow" | "deep"): TaskScope
}

export function harness(opts: {
	search?: SearchProvider[]
	fetch?: FetchProvider[]
	profile?: Obj | undefined
	limits?: CallLimits
	attempts?: number
	gatewayLimits?: Partial<GatewayLimits>
	fxRates?: Record<string, number>
} = {}): Harness {
	const state = new RunState()
	state.runId = "r_test"
	if (opts.profile !== undefined || !("profile" in opts)) state.profile = opts.profile ?? profile()
	state.topics.set("t_001", { id: "t_001", title: "Competitor pricing", category: "pricing", state: "deep" })
	const emitter = new RecordingEmitter()
	const content = new MemoryContentStore()
	const ids = new IdGenerator(state)
	const library = new SourceLibrary({ state, ids, clock: fixedClock, content, emitter })
	const store = new ResearchStore({ state, ids, library, emitter, clock: fixedClock, ...(opts.fxRates ? { fxRates: opts.fxRates } : {}) })
	const meter = new UsageMeter()
	const budget = new CallBudget(opts.limits)
	const cache = new MemoryCache()
	const gateway = new ResearchGateway({
		searchProviders: opts.search ?? [],
		fetchProviders: opts.fetch ?? [],
		cache,
		redactor: new LiveRedactor(() => state.profile),
		library,
		meter,
		budget,
		limiter: new RateLimiter({ maxConcurrent: 4, minIntervalMs: 0 }, async () => {}),
		retry: fastRetry(opts.attempts ?? 3),
		clock: fixedClock,
		...(opts.gatewayLimits ? { limits: opts.gatewayLimits } : {}),
	})
	return {
		state, emitter, library, store, gateway, meter, budget, content, cache,
		scope: (role = "analyst", topicId = "t_001", depth = "deep") => new TaskScope("slot_1", role, topicId, emitter, "pricing", depth),
	}
}
