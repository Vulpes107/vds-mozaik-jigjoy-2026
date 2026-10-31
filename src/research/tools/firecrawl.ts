// Fourth adapter: Firecrawl's free, accountless "keyless" Search/Scrape API (https://api.firecrawl.dev/v2). No API
// key needed for 1,000 free credits/month; an optional FIRECRAWL_API_KEY raises the limit via a Bearer token but
// is never required. Plain REST, not MCP — simpler than the Parallel/You.com adapters.
// Caveat verified live (2026-10-31): Firecrawl's keyless mode 403s requests from IPs it classifies as VPN/proxy
// (e.g. cloud dev sandboxes), so this adapter is tested against the documented response shape, not a live call
// from this environment. Re-verify from wherever this actually runs before relying on it.
import {
	type FetchOptions,
	type FetchProvider,
	type FetchResult,
	type SearchOptions,
	type SearchProvider,
	type SearchResult,
	classifyError,
} from "./provider.ts"

const BASE_URL = "https://api.firecrawl.dev/v2"

/** The slice of `fetch` we use, so tests can pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Carries `status` so `classifyError` (provider.ts) can map it to the right ProviderErrorKind (404 -> not_found, etc). */
const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status })

class FirecrawlClient {
	constructor(private readonly opts: { apiKey?: string | undefined; fetch?: FetchLike; baseUrl?: string } = {}) {}

	async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
		const doFetch = this.opts.fetch ?? fetch
		const headers: Record<string, string> = { "content-type": "application/json" }
		if (this.opts.apiKey) headers["authorization"] = `Bearer ${this.opts.apiKey}`
		let res: Response
		try {
			res = await doFetch(`${this.opts.baseUrl ?? BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) })
		} catch (err) {
			throw classifyError(err)
		}
		const json = (await res.json().catch(() => undefined)) as { success?: boolean; error?: string } | undefined
		if (!res.ok || json?.success === false) {
			throw classifyError(httpError(res.status, json?.error ?? `${res.status} ${res.statusText}`))
		}
		return json as T
	}
}

interface FirecrawlWebResult {
	url: string
	title?: string
	description?: string
	markdown?: string | null
	metadata?: { statusCode?: number; error?: string | null }
}
interface FirecrawlSearchResponse {
	data: { web?: FirecrawlWebResult[] }
}

const matchesDomains = (url: string, include: string[] | undefined, exclude: string[] | undefined): boolean => {
	let host: string
	try {
		host = new URL(url).hostname
	} catch {
		return false
	}
	if (exclude?.some((d) => host.endsWith(d))) return false
	if (include?.length && !include.some((d) => host.endsWith(d))) return false
	return true
}

export class FirecrawlSearchProvider implements SearchProvider {
	readonly name = "firecrawl"
	constructor(private readonly client: FirecrawlClient) {}

	async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
		try {
			const res = await this.client.post<FirecrawlSearchResponse>("/search", {
				query: query.slice(0, 500),
				limit: Math.min(Math.max(opts.maxResults ?? 10, 1), 100),
				...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
				...(opts.excludeDomains?.length ? { excludeDomains: opts.excludeDomains } : {}),
			})
			return (res.data.web ?? [])
				.filter((r) => matchesDomains(r.url, opts.includeDomains, opts.excludeDomains))
				.slice(0, opts.maxResults ?? 5)
				.map((r) => ({ title: r.title ?? "", url: r.url, snippet: r.description ?? "" }))
		} catch (err) {
			throw classifyError(err)
		}
	}
}

interface FirecrawlScrapeResponse {
	data: { markdown?: string; metadata?: { title?: string | string[]; statusCode?: number; error?: string | null } }
}

export class FirecrawlFetchProvider implements FetchProvider {
	readonly name = "firecrawl"
	constructor(private readonly client: FirecrawlClient) {}

	async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
		const fetchedAt = new Date().toISOString()
		try {
			const res = await this.client.post<FirecrawlScrapeResponse>("/scrape", { url, formats: ["markdown"], onlyMainContent: true, timeout: opts.depth === "advanced" ? 60_000 : 20_000 })
			const title = Array.isArray(res.data.metadata?.title) ? (res.data.metadata?.title[0] ?? "") : res.data.metadata?.title ?? ""
			const status = res.data.metadata?.statusCode ?? 200
			const error = res.data.metadata?.error ?? undefined
			return { url, title, text: res.data.markdown ?? "", status, fetchedAt, ...(error ? { error } : {}) }
		} catch (err) {
			const e = classifyError(err)
			if (e.kind === "not_found" || e.kind === "bad_request") return { url, title: "", text: "", status: e.kind === "not_found" ? 404 : 403, fetchedAt, error: e.message }
			throw e
		}
	}

	/** Firecrawl's scrape endpoint is one URL per call; batch by running them concurrently. */
	async fetchMany(urls: string[], opts: FetchOptions = {}): Promise<FetchResult[]> {
		return Promise.all(urls.slice(0, 20).map((u) => this.fetch(u, opts)))
	}
}

/** Convenience: both Firecrawl pieces, accountless by default (the keyless free tier). */
export function firecrawlProviders(opts: { apiKey?: string | undefined; fetch?: FetchLike } = {}) {
	const client = new FirecrawlClient({ apiKey: opts.apiKey ?? process.env.FIRECRAWL_API_KEY, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
	return { search: new FirecrawlSearchProvider(client), fetch: new FirecrawlFetchProvider(client) }
}
