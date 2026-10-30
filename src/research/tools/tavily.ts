// First adapter: Tavily via the SDK (@tavily/core). The CLI is for manual debugging only.
// Everything Tavily-specific stays in this file; agents see only the interfaces in provider.ts.
import { tavily, type TavilyClient } from "@tavily/core"
import {
	type CrawlOptions,
	type CrawlPage,
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

/** The slice of the SDK we use, so tests can pass a fake client. */
export type TavilyLike = Pick<TavilyClient, "search" | "extract" | "map" | "crawl" | "research" | "getResearch">

export function createTavilyClient(apiKey = process.env.TAVILY_API_KEY): TavilyLike {
	if (!apiKey) throw new ProviderError("auth", "TAVILY_API_KEY is not set (add it to this machine's .env)", { retryable: false })
	return tavily({ apiKey, clientSource: "mozaik-market-intel" })
}

const dayCount = (d?: number): "day" | "week" | "month" | "year" | undefined =>
	d === undefined ? undefined : d <= 1 ? "day" : d <= 7 ? "week" : d <= 31 ? "month" : "year"

const validDate = (s: string | undefined): string | undefined => {
	if (!s) return undefined
	const t = Date.parse(s)
	return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10)
}

export class TavilySearchProvider implements SearchProvider {
	readonly name = "tavily"
	constructor(private readonly client: TavilyLike) {}

	async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
		try {
			const range = dayCount(opts.recencyDays)
			const res = await this.client.search(query, {
				searchDepth: opts.depth === "advanced" ? "advanced" : "basic",
				maxResults: opts.maxResults ?? 5,
				topic: opts.kind ?? "general",
				includeAnswer: false,
				...(range ? { timeRange: range } : {}),
				...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
				...(opts.excludeDomains?.length ? { excludeDomains: opts.excludeDomains } : {}),
			})
			return (res.results ?? []).map((r) => {
				const publishedAt = validDate(r.publishedDate)
				return { title: r.title ?? "", url: r.url, snippet: r.content ?? "", ...(publishedAt ? { publishedAt } : {}) }
			})
		} catch (err) {
			throw classifyError(err)
		}
	}
}

export class TavilyFetchProvider implements FetchProvider {
	readonly name = "tavily"
	constructor(private readonly client: TavilyLike) {}

	async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
		const [r] = await this.fetchMany([url], opts)
		return r ?? { url, title: "", text: "", status: 0, fetchedAt: new Date().toISOString(), error: "empty response" }
	}

	/** Tavily extracts up to 20 URLs in one call. Results are returned in input order. */
	async fetchMany(urls: string[], opts: FetchOptions = {}): Promise<FetchResult[]> {
		try {
			const res = await this.client.extract(urls.slice(0, 20), {
				extractDepth: opts.depth === "advanced" ? "advanced" : "basic",
				format: "markdown",
				...(opts.focus ? { query: opts.focus, chunksPerSource: 3 } : {}),
			})
			const fetchedAt = new Date().toISOString()
			const ok = new Map(res.results.map((r) => [r.url, r]))
			const bad = new Map(res.failedResults.map((r) => [r.url, r.error]))
			return urls.map((url): FetchResult => {
				const r = ok.get(url)
				if (r) return { url, title: r.title ?? "", text: r.rawContent ?? "", status: 200, fetchedAt }
				const error = bad.get(url) ?? "not returned by provider"
				const status = /\b404\b|not found/i.test(error) ? 404 : /\b40[13]\b|forbidden|blocked|denied/i.test(error) ? 403 : 0
				return { url, title: "", text: "", status, fetchedAt, error }
			})
		} catch (err) {
			throw classifyError(err)
		}
	}
}

/** map / crawl / research are Tavily-only. Roles that use them declare the dependency; without them they degrade. */
export class TavilyExtras implements ResearchExtras {
	readonly name = "tavily"
	constructor(
		private readonly client: TavilyLike,
		private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
		private readonly pollMs = 3000,
		private readonly maxPolls = 40,
	) {}

	async map(url: string, opts: MapOptions = {}): Promise<string[]> {
		try {
			const res = await this.client.map(url, {
				limit: opts.limit ?? 50,
				maxDepth: opts.maxDepth ?? 1,
				...(opts.selectPaths?.length ? { selectPaths: opts.selectPaths } : {}),
				...(opts.instructions ? { instructions: opts.instructions } : {}),
			})
			return res.results ?? []
		} catch (err) {
			throw classifyError(err)
		}
	}

	async crawl(url: string, opts: CrawlOptions = {}): Promise<CrawlPage[]> {
		try {
			const res = await this.client.crawl(url, {
				limit: opts.pageLimit ?? 5,
				maxDepth: opts.maxDepth ?? 1,
				maxBreadth: opts.maxBreadth ?? 10,
				format: "markdown",
				allowExternal: false,
				...(opts.selectPaths?.length ? { selectPaths: opts.selectPaths } : {}),
				...(opts.instructions ? { instructions: opts.instructions } : {}),
			})
			return (res.results ?? []).map((r) => ({ url: r.url, text: r.rawContent ?? "" }))
		} catch (err) {
			throw classifyError(err)
		}
	}

	async research(question: string, opts: { model?: "mini" | "pro" | "auto" } = {}): Promise<{ content: string; sources: { title: string; url: string }[] }> {
		try {
			const started = (await this.client.research(question, { model: opts.model ?? "mini", stream: false })) as { requestId: string }
			for (let i = 0; i < this.maxPolls; i++) {
				const res = await this.client.getResearch(started.requestId)
				if (res.status === "completed" && "content" in res) {
					const content = typeof res.content === "string" ? res.content : JSON.stringify(res.content)
					return { content, sources: res.sources ?? [] }
				}
				if (res.status === "failed") throw new ProviderError("unavailable", "research request failed")
				await this.sleep(this.pollMs)
			}
			throw new ProviderError("timeout", "research request did not complete in time")
		} catch (err) {
			throw classifyError(err)
		}
	}
}

/** Convenience: all three Tavily pieces from one client. */
export function tavilyProviders(client: TavilyLike = createTavilyClient()) {
	return { search: new TavilySearchProvider(client), fetch: new TavilyFetchProvider(client), extras: new TavilyExtras(client) }
}
