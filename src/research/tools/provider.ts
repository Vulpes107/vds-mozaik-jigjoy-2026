// Provider-neutral search/fetch interfaces (docs/MASTERPLAN.md §5). Agents never see a vendor SDK:
// a new provider is a new adapter implementing these, nothing else changes.

export interface SearchOptions {
	maxResults?: number
	/** Only results from the last N days. */
	recencyDays?: number
	includeDomains?: string[]
	excludeDomains?: string[]
	kind?: "general" | "news" | "finance"
	/** "basic" is cheap breadth; "advanced" costs more and is for Deep topics. */
	depth?: "basic" | "advanced"
}

export interface SearchResult {
	title: string
	url: string
	snippet: string
	publishedAt?: string
}

export interface SearchProvider {
	readonly name: string
	search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
}

export interface FetchOptions {
	/** Optional focus query so the provider can return the relevant chunks of a long page. */
	focus?: string
	depth?: "basic" | "advanced"
}

export interface FetchResult {
	url: string
	title: string
	text: string
	/** HTTP-like status; 0 when the provider could not retrieve the page at all. */
	status: number
	fetchedAt: string
	publishedAt?: string
	error?: string
}

export interface FetchProvider {
	readonly name: string
	fetch(url: string, opts?: FetchOptions): Promise<FetchResult>
	/** Optional batch path (Tavily extracts up to 20 URLs per call). Results come back in input order. */
	fetchMany?(urls: string[], opts?: FetchOptions): Promise<FetchResult[]>
}

/** Optional, provider-specific extras. A provider without them degrades to search + fetch. */
export interface MapOptions {
	limit?: number
	maxDepth?: number
	selectPaths?: string[]
	instructions?: string
}
export interface CrawlOptions extends MapOptions {
	maxBreadth?: number
	/** Hard cap on pages returned; the adapter layer clamps it further. */
	pageLimit?: number
}
export interface CrawlPage {
	url: string
	text: string
}
export interface ResearchExtras {
	readonly name: string
	map?(url: string, opts?: MapOptions): Promise<string[]>
	crawl?(url: string, opts?: CrawlOptions): Promise<CrawlPage[]>
	research?(question: string, opts?: { model?: "mini" | "pro" | "auto" }): Promise<{ content: string; sources: { title: string; url: string }[] }>
}

export type ProviderErrorKind = "rate_limited" | "unavailable" | "timeout" | "auth" | "bad_request" | "not_found" | "unknown"

export class ProviderError extends Error {
	readonly kind: ProviderErrorKind
	readonly retryable: boolean
	readonly retryAfterMs?: number
	constructor(kind: ProviderErrorKind, message: string, opts: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {}) {
		super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
		this.name = "ProviderError"
		this.kind = kind
		this.retryable = opts.retryable ?? (kind === "rate_limited" || kind === "unavailable" || kind === "timeout")
		if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
	}
}

/** Map whatever an SDK threw to a ProviderError. Vendor SDKs mostly throw plain Errors with the status in the text. */
export function classifyError(err: unknown): ProviderError {
	if (err instanceof ProviderError) return err
	const message = err instanceof Error ? err.message : String(err)
	const anyErr = err as { status?: number; response?: { status?: number }; code?: string } | undefined
	const status = anyErr?.status ?? anyErr?.response?.status ?? Number(/\b([45]\d\d)\b/.exec(message)?.[1])
	const code = anyErr?.code ?? ""
	if (status === 429 || /rate.?limit|too many requests|usage limit|credits?/i.test(message)) {
		return new ProviderError("rate_limited", message, { cause: err })
	}
	if (status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|forbidden/i.test(message)) {
		return new ProviderError("auth", message, { retryable: false, cause: err })
	}
	if (status === 404) return new ProviderError("not_found", message, { retryable: false, cause: err })
	if (status && status >= 400 && status < 500) return new ProviderError("bad_request", message, { retryable: false, cause: err })
	if (/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError/i.test(message + code)) return new ProviderError("timeout", message, { cause: err })
	if ((status && status >= 500) || /ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|unavailable/i.test(message + code)) {
		return new ProviderError("unavailable", message, { cause: err })
	}
	return new ProviderError("unknown", message, { retryable: false, cause: err })
}
