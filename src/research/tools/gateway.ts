// The adapter layer from MASTERPLAN §5. Everything an agent does on the open web goes through here, so the rules
// live in one place and not in agent instructions: redaction -> cache -> call budget -> rate limit -> retry/backoff
// -> provider fallback -> metering -> injection scan -> source registration.
import type { SourceLibrary } from "../sources.ts"
import { scanForInjection } from "../safety/injection.ts"
import type { Clock, CallContext } from "../types.ts"
import { type CacheStore, cacheKey } from "./cache.ts"
import {
	type CrawlOptions,
	type FetchOptions,
	type FetchProvider,
	type FetchResult,
	type MapOptions,
	ProviderError,
	type ResearchExtras,
	type SearchOptions,
	type SearchProvider,
	type SearchResult,
	classifyError,
} from "./provider.ts"
import type { RedactorLike } from "./redact.ts"
import { BudgetStop, type RateLimiter, type RetryPolicy, withRetry } from "./resilience.ts"
import type { CallBudget, UsageMeter } from "./usage.ts"
import { canonicalUrl, registrableHost } from "../scoring.ts"

export type ErrorCode = "invalid_input" | "query_rejected" | "budget_exhausted" | "provider_unavailable" | "unsupported" | "not_allowed"
export type Failure = { ok: false; error: ErrorCode; message: string }

export interface SearchHit {
	title: string
	url: string
	snippet: string
	publishedAt?: string
	sourceId: string
	injectionFlagged: boolean
}
export type SearchOutcome =
	| { ok: true; results: SearchHit[]; provider: string; tookMs: number; cached: boolean; redactions: string[]; query: string }
	| Failure

export interface Page {
	url: string
	title: string
	/** Cleaned text, truncated to `maxTextChars`. The full cleaned text is in the content store. */
	text: string
	truncated: boolean
	status: number
	fetchedAt: string
	sourceId?: string
	injectionFlagged: boolean
	blocked?: boolean
	/** Content came from a search snippet because the page itself could not be fetched. */
	degraded?: boolean
	error?: string
}
export type FetchOutcome = { ok: true; pages: Page[]; provider: string; tookMs: number } | Failure

export interface GatewayDeps {
	searchProviders: SearchProvider[]
	fetchProviders: FetchProvider[]
	extras?: ResearchExtras
	cache: CacheStore
	redactor: RedactorLike
	library: SourceLibrary
	meter: UsageMeter
	budget: CallBudget
	limiter: RateLimiter
	retry: () => RetryPolicy
	clock: Clock
	limits?: Partial<GatewayLimits>
}

export interface GatewayLimits {
	maxResults: number
	maxFetchUrls: number
	maxTextChars: number
	crawlPages: number
	crawlDepth: number
	searchTtlMs: number
	fetchTtlMs: number
	/** Calls a Tavily-style `research` request is charged against the budget (it is the most expensive operation). */
	researchCost: number
}

const DEFAULT_LIMITS: GatewayLimits = {
	maxResults: 8,
	maxFetchUrls: 20,
	maxTextChars: 12_000,
	crawlPages: 10,
	crawlDepth: 2,
	searchTtlMs: 24 * 3600_000,
	fetchTtlMs: 7 * 24 * 3600_000,
	researchCost: 5,
}

const BLOCKED_TEXT = /\b(subscribe to (read|continue)|sign in to (read|continue|view)|log ?in to (read|continue|view)|enable javascript|verify you are human|access denied|403 forbidden|captcha|paywall|this content is for subscribers)\b/i

const fail = (error: ErrorCode, message: string): Failure => ({ ok: false, error, message })

export class ResearchGateway {
	readonly limits: GatewayLimits

	constructor(private readonly d: GatewayDeps) {
		this.limits = { ...DEFAULT_LIMITS, ...d.limits }
	}

	// ---- search ------------------------------------------------------------------------------------------

	async search(ctx: CallContext, rawQuery: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
		const query = (rawQuery ?? "").trim()
		if (!query) return fail("invalid_input", "query is empty")
		if (query.length > 400) return fail("invalid_input", "query is longer than 400 characters; use a focused search phrase")

		const red = this.d.redactor.redactQuery(query, ctx.category ? { category: ctx.category } : {})
		if (red.rejected) return fail("query_rejected", red.rejected)

		const effective: SearchOptions = {
			...opts,
			maxResults: Math.min(opts.maxResults ?? 5, this.limits.maxResults),
			// Breadth passes are always cheap; advanced depth is for Deep topics only.
			depth: ctx.depth === "deep" ? (opts.depth ?? "basic") : "basic",
		}
		const started = Date.now()
		const key = cacheKey("search", { q: red.text, o: effective })
		const hit = await this.d.cache.get(key)
		let results: SearchResult[] | undefined
		let provider = ""
		let cached = false
		if (hit && this.d.clock.now().getTime() - hit.storedAt < this.limits.searchTtlMs) {
			const v = hit.value as { results: SearchResult[]; provider: string }
			results = v.results
			provider = v.provider
			cached = true
			this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool: "web_search", provider, cached: true, ms: 0, ok: true })
		} else {
			const out = await this.callProviders(ctx, "web_search", this.d.searchProviders, (p) => p.search(red.text, effective))
			if (!out.ok) return out
			results = out.value
			provider = out.provider
			await this.d.cache.set(key, { value: { results, provider }, storedAt: this.d.clock.now().getTime() })
		}

		const hits: SearchHit[] = []
		for (const r of results) {
			const cand = this.d.library.observe({ url: r.url, title: r.title, tool: "search", ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}) })
			if (!cand) continue
			const scan = this.d.library.scan(cand, `${r.title}\n${r.snippet}`, { topicId: ctx.topicId, slotId: ctx.slotId })
			const [title = "", ...rest] = scan.cleaned.split("\n")
			hits.push({
				title: title.slice(0, 200),
				url: r.url,
				snippet: rest.join("\n").slice(0, 1200),
				...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
				sourceId: cand.id,
				injectionFlagged: scan.flagged,
			})
		}
		return { ok: true, results: hits, provider, tookMs: cached ? 0 : Date.now() - started, cached, redactions: red.redactions, query: red.text }
	}

	// ---- fetch -------------------------------------------------------------------------------------------

	async fetch(ctx: CallContext, rawUrls: string[], opts: FetchOptions = {}): Promise<FetchOutcome> {
		const urls = [...new Set(rawUrls.map((u) => (u ?? "").trim()).filter(Boolean))]
		if (urls.length === 0) return fail("invalid_input", "no URL given")
		if (urls.length > this.limits.maxFetchUrls) return fail("invalid_input", `at most ${this.limits.maxFetchUrls} URLs per call`)

		const started = Date.now()
		const focus = opts.focus ? this.d.redactor.redactQuery(opts.focus, ctx.category ? { category: ctx.category } : {}) : undefined
		const effective: FetchOptions = { depth: ctx.depth === "deep" ? (opts.depth ?? "basic") : "basic", ...(focus && !focus.rejected && focus.text ? { focus: focus.text } : {}) }

		const pages = new Map<string, Page>()
		const todo: string[] = []
		for (const url of urls) {
			if (!/^https?:\/\//i.test(url)) {
				pages.set(url, this.failedPage(url, 0, "Only http(s) URLs can be fetched"))
				continue
			}
			const allowed = this.d.redactor.checkUrl(url)
			if (!allowed.ok) {
				pages.set(url, this.failedPage(url, 0, allowed.reason))
				continue
			}
			const hit = await this.d.cache.get(cacheKey("fetch", { u: canonicalUrl(url), o: effective }))
			if (hit && this.d.clock.now().getTime() - hit.storedAt < this.limits.fetchTtlMs) {
				this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool: "web_fetch", provider: "cache", cached: true, ms: 0, ok: true })
				pages.set(url, await this.ingest(ctx, hit.value as FetchResult))
			} else todo.push(url)
		}

		let provider = "cache"
		let remaining = todo
		let lastError: Failure | undefined
		for (const p of this.d.fetchProviders) {
			if (remaining.length === 0) break
			const res = await this.fetchWith(ctx, p, remaining, effective)
			if (res.kind === "stop") return res.failure
			if (res.kind === "error") {
				lastError = fail("provider_unavailable", res.message)
				continue
			}
			provider = p.name
			const stillMissing: string[] = []
			for (const [url, r] of res.results) {
				if (r.status >= 200 && r.status < 400 && r.text.trim()) {
					await this.d.cache.set(cacheKey("fetch", { u: canonicalUrl(url), o: effective }), { value: r, storedAt: this.d.clock.now().getTime() })
					pages.set(url, await this.ingest(ctx, r))
				} else if (r.status === 0 || r.status >= 500) stillMissing.push(url) // try the next provider
				else pages.set(url, await this.ingest(ctx, r)) // 4xx: the page is really gone / refused; record it
			}
			remaining = stillMissing
		}

		for (const url of remaining) {
			const degraded = await this.snippetFallback(ctx, url)
			if (degraded) {
				pages.set(url, degraded)
				continue
			}
			ctx.recordGap(`fetch_failed: ${registrableHost(url) || url}`)
			pages.set(url, this.failedPage(url, 0, lastError?.message ?? "no provider could retrieve this page"))
		}

		const ordered = urls.map((u) => pages.get(u)).filter((p): p is Page => !!p)
		// Nothing at all could be retrieved: say so plainly (the per-page gaps are already recorded).
		if (todo.length > 0 && ordered.every((p) => p.status === 0)) {
			const why = lastError?.message ?? ordered.find((p) => p.error)?.error ?? "unknown"
			return fail("provider_unavailable", `No page could be retrieved (${why}). Do not guess their content; this gap has been recorded.`)
		}
		return { ok: true, pages: ordered, provider, tookMs: Date.now() - started }
	}

	private async fetchWith(
		ctx: CallContext,
		p: FetchProvider,
		urls: string[],
		opts: FetchOptions,
	): Promise<{ kind: "ok"; results: [string, FetchResult][] } | { kind: "error"; message: string } | { kind: "stop"; failure: Failure }> {
		const t0 = Date.now()
		try {
			let results: [string, FetchResult][]
			if (urls.length > 1 && p.fetchMany) {
				const batch = await this.attempt(ctx, () => p.fetchMany!(urls, opts))
				results = urls.map((u, i): [string, FetchResult] => [u, batch[i] ?? this.emptyResult(u, "missing from batch response")])
			} else {
				results = []
				for (const u of urls) {
					try {
						results.push([u, await this.attempt(ctx, () => p.fetch(u, opts))])
					} catch (err) {
						if (err instanceof BudgetStop) throw err
						const e = classifyError(err)
						// A page the site refuses is a page-level result; only transient/provider failures fall through.
						results.push([u, this.emptyResult(u, e.message, e.kind === "not_found" ? 404 : e.retryable || e.kind === "unknown" ? 0 : 400)])
					}
				}
			}
			this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool: "web_fetch", provider: p.name, cached: false, ms: Date.now() - t0, ok: true })
			return { kind: "ok", results }
		} catch (err) {
			this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool: "web_fetch", provider: p.name, cached: false, ms: Date.now() - t0, ok: false })
			if (err instanceof BudgetStop) {
				ctx.recordGap(`budget_exhausted: ${err.message}`)
				return { kind: "stop", failure: fail("budget_exhausted", err.message) }
			}
			return { kind: "error", message: classifyError(err).message }
		}
	}

	/** Last resort when no provider can fetch a page: reuse the search snippet for that exact URL, flagged as degraded. */
	private async snippetFallback(ctx: CallContext, url: string): Promise<Page | undefined> {
		if (this.d.searchProviders.length === 0) return undefined
		const host = registrableHost(url)
		if (!host) return undefined
		const words = (() => {
			try {
				return new URL(url).pathname.split(/[\/_.-]+/).filter((w) => w.length > 2).join(" ")
			} catch {
				return ""
			}
		})()
		const out = await this.search(ctx, `${host} ${words}`.trim(), { includeDomains: [host], maxResults: 5 })
		if (!out.ok) return undefined
		const match = out.results.find((r) => canonicalUrl(r.url) === canonicalUrl(url))
		if (!match || !match.snippet) return undefined
		const text = match.snippet
		return {
			url,
			title: match.title,
			text,
			truncated: false,
			status: 200,
			fetchedAt: this.d.clock.now().toISOString(),
			sourceId: match.sourceId,
			injectionFlagged: match.injectionFlagged,
			degraded: true,
		}
	}

	private async ingest(ctx: CallContext, r: FetchResult): Promise<Page> {
		const cand = this.d.library.observe({ url: r.url, title: r.title, tool: "extract", ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}) })
		if (!cand) return this.failedPage(r.url, r.status, "invalid URL")
		const failed = r.status === 0 || r.status >= 400 || !r.text.trim()
		const blocked = !failed && r.text.length < 800 && BLOCKED_TEXT.test(r.text)
		if (failed || blocked) {
			ctx.recordGap(`${blocked ? "blocked_page" : "fetch_failed"}: ${registrableHost(r.url) || r.url}`)
			return { ...this.failedPage(r.url, r.status, blocked ? "page is behind a paywall, login or bot check" : (r.error ?? `status ${r.status}`)), sourceId: cand.id, ...(blocked ? { blocked: true } : {}) }
		}
		if (!Number.isNaN(Date.parse(r.fetchedAt))) cand.retrievedAt = new Date(r.fetchedAt).toISOString()
		const scan = scanForInjection(r.text)
		await this.d.library.attachContent(cand.id, r.text, scan, { topicId: ctx.topicId, slotId: ctx.slotId })
		const cut = scan.cleaned.length > this.limits.maxTextChars
		return {
			url: r.url,
			title: r.title,
			text: cut ? scan.cleaned.slice(0, this.limits.maxTextChars) : scan.cleaned,
			truncated: cut,
			status: r.status,
			fetchedAt: r.fetchedAt,
			sourceId: cand.id,
			injectionFlagged: scan.flagged,
		}
	}

	private failedPage(url: string, status: number, error: string): Page {
		return { url, title: "", text: "", truncated: false, status, fetchedAt: this.d.clock.now().toISOString(), injectionFlagged: false, error }
	}

	private emptyResult(url: string, error: string, status = 0): FetchResult {
		return { url, title: "", text: "", status, fetchedAt: this.d.clock.now().toISOString(), error }
	}

	// ---- optional extras (Tavily map / crawl / research) ------------------------------------------------------

	async map(ctx: CallContext, url: string, opts: MapOptions = {}): Promise<{ ok: true; urls: string[]; provider: string } | Failure> {
		const extras = this.d.extras
		if (!extras?.map) return fail("unsupported", "This provider has no site-map capability. Use web_search with a domain filter, then web_fetch.")
		const bad = this.checkUrl(url)
		if (bad) return bad
		const clamped: MapOptions = { ...opts, limit: Math.min(opts.limit ?? 50, 100), maxDepth: Math.min(opts.maxDepth ?? 1, this.limits.crawlDepth) }
		if (clamped.instructions) clamped.instructions = this.redactFree(clamped.instructions, ctx)
		const out = await this.callExtra(ctx, "tavily_map", 1, { url: canonicalUrl(url), clamped }, () => extras.map!(url, clamped))
		if (!out.ok) return out
		return { ok: true, urls: out.value.slice(0, 100), provider: extras.name }
	}

	async crawl(ctx: CallContext, url: string, opts: CrawlOptions = {}): Promise<{ ok: true; pages: Page[]; provider: string } | Failure> {
		const extras = this.d.extras
		if (!extras?.crawl) return fail("unsupported", "This provider has no crawl capability. Use web_search plus web_fetch on specific URLs.")
		const bad = this.checkUrl(url)
		if (bad) return bad
		const pageLimit = Math.min(opts.pageLimit ?? 5, this.limits.crawlPages)
		const clamped: CrawlOptions = { ...opts, pageLimit, maxDepth: Math.min(opts.maxDepth ?? 1, this.limits.crawlDepth), maxBreadth: Math.min(opts.maxBreadth ?? 10, 20) }
		if (clamped.instructions) clamped.instructions = this.redactFree(clamped.instructions, ctx)
		const out = await this.callExtra(ctx, "tavily_crawl", 1 + Math.ceil(pageLimit / 5), { url: canonicalUrl(url), clamped }, () => extras.crawl!(url, clamped))
		if (!out.ok) return out
		const pages: Page[] = []
		for (const r of out.value.slice(0, pageLimit)) {
			const cand = this.d.library.observe({ url: r.url, tool: "crawl" })
			if (!cand || !r.text.trim()) continue
			const scan = scanForInjection(r.text)
			await this.d.library.attachContent(cand.id, r.text, scan, { topicId: ctx.topicId, slotId: ctx.slotId })
			// Crawls can be large; the model gets a short preview and reads the rest via the stored material.
			const preview = scan.cleaned.slice(0, 2000)
			pages.push({ url: r.url, title: "", text: preview, truncated: scan.cleaned.length > preview.length, status: 200, fetchedAt: this.d.clock.now().toISOString(), sourceId: cand.id, injectionFlagged: scan.flagged })
		}
		return { ok: true, pages, provider: extras.name }
	}

	async research(ctx: CallContext, question: string, opts: { model?: "mini" | "pro" | "auto" } = {}): Promise<{ ok: true; report: string; sourceIds: string[]; injectionFlagged: boolean; provider: string } | Failure> {
		const extras = this.d.extras
		if (!extras?.research) return fail("unsupported", "This provider has no research capability. Use web_search plus web_fetch.")
		if (ctx.depth !== "deep") return fail("not_allowed", "Cited research is the most expensive operation and is reserved for Deep topics.")
		const red = this.d.redactor.redactQuery(question, ctx.category ? { category: ctx.category } : {})
		if (red.rejected) return fail("query_rejected", red.rejected)
		const out = await this.callExtra(ctx, "tavily_research", this.limits.researchCost, { q: red.text, opts }, () => extras.research!(red.text, opts))
		if (!out.ok) return out
		const scan = scanForInjection(out.value.content)
		const sourceIds: string[] = []
		let flagged = scan.flagged
		for (const s of out.value.sources.slice(0, 15)) {
			const cand = this.d.library.observe({ url: s.url, title: s.title, tool: "research" })
			if (!cand) continue
			sourceIds.push(cand.id)
			if (scan.flagged) this.d.library.noteInjection(cand, scan, { topicId: ctx.topicId, slotId: ctx.slotId })
			flagged ||= cand.injectionPatterns.length > 0
		}
		return { ok: true, report: scan.cleaned.slice(0, this.limits.maxTextChars), sourceIds, injectionFlagged: flagged, provider: extras.name }
	}

	// ---- plumbing ----------------------------------------------------------------------------------------

	private checkUrl(url: string): Failure | undefined {
		if (!/^https?:\/\//i.test(url ?? "")) return fail("invalid_input", "url must be an http(s) URL")
		const allowed = this.d.redactor.checkUrl(url)
		return allowed.ok ? undefined : fail("query_rejected", allowed.reason)
	}

	private redactFree(text: string, ctx: CallContext): string {
		const r = this.d.redactor.redactQuery(text, ctx.category ? { category: ctx.category } : {})
		return r.rejected ? "" : r.text
	}

	/** One provider call: rate limited, retried, and charged against the call budget per attempt. */
	private attempt<T>(ctx: CallContext, fn: () => Promise<T>, cost = 1): Promise<T> {
		const policy = this.d.retry()
		policy.beforeAttempt = () => {
			for (let i = 0; i < cost; i++) this.d.budget.charge(ctx.topicId)
		}
		return withRetry(() => this.d.limiter.run(fn), policy).then((r) => r.value)
	}

	/** Try providers in order; the first that answers wins. Records a gap only when every provider failed. */
	private async callProviders<P extends { name: string }, T>(
		ctx: CallContext,
		tool: string,
		providers: P[],
		fn: (p: P) => Promise<T>,
	): Promise<{ ok: true; value: T; provider: string } | Failure> {
		let last = "no provider configured"
		for (const p of providers) {
			const t0 = Date.now()
			try {
				const value = await this.attempt(ctx, () => fn(p))
				this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool, provider: p.name, cached: false, ms: Date.now() - t0, ok: true })
				return { ok: true, value, provider: p.name }
			} catch (err) {
				this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool, provider: p.name, cached: false, ms: Date.now() - t0, ok: false })
				if (err instanceof BudgetStop) {
					ctx.recordGap(`budget_exhausted: ${err.message}`)
					return fail("budget_exhausted", `${err.message}. Stop searching and work with what you have.`)
				}
				last = classifyError(err).message
			}
		}
		ctx.recordGap(`${tool}_unavailable: ${last}`.slice(0, 300))
		return fail("provider_unavailable", `All providers failed (${last}). Do not guess; this gap has been recorded.`)
	}

	private async callExtra<T>(ctx: CallContext, tool: string, cost: number, args: unknown, fn: () => Promise<T>): Promise<{ ok: true; value: T } | Failure> {
		const key = cacheKey(tool, args)
		const hit = await this.d.cache.get(key)
		if (hit && this.d.clock.now().getTime() - hit.storedAt < this.limits.fetchTtlMs) {
			this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool, provider: this.d.extras?.name ?? "", cached: true, ms: 0, ok: true })
			return { ok: true, value: hit.value as T }
		}
		const t0 = Date.now()
		try {
			const value = await this.attempt(ctx, fn, cost)
			this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool, provider: this.d.extras?.name ?? "", cached: false, ms: Date.now() - t0, ok: true })
			await this.d.cache.set(key, { value, storedAt: this.d.clock.now().getTime() })
			return { ok: true, value }
		} catch (err) {
			this.d.meter.record({ slotId: ctx.slotId, topicId: ctx.topicId, tool, provider: this.d.extras?.name ?? "", cached: false, ms: Date.now() - t0, ok: false })
			if (err instanceof BudgetStop) {
				ctx.recordGap(`budget_exhausted: ${err.message}`)
				return fail("budget_exhausted", err.message)
			}
			const e = err instanceof ProviderError ? err : classifyError(err)
			ctx.recordGap(`${tool}_unavailable: ${e.message}`.slice(0, 300))
			return fail("provider_unavailable", `${tool} failed (${e.message}). Fall back to web_search + web_fetch.`)
		}
	}
}
