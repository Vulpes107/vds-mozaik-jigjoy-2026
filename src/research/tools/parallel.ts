// Second adapter: Parallel's free, accountless Search MCP (https://search.parallel.ai/mcp). No API key needed;
// an optional PARALLEL_API_KEY raises the anonymous rate limit via a Bearer token but is never required.
// Everything MCP/Parallel-specific stays in this file; agents see only the interfaces in provider.ts.
import {
	type FetchOptions,
	type FetchProvider,
	type FetchResult,
	ProviderError,
	type SearchOptions,
	type SearchProvider,
	type SearchResult,
	classifyError,
} from "./provider.ts"

const MCP_URL = "https://search.parallel.ai/mcp"
const PROTOCOL_VERSION = "2024-11-05"

type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } }

/** The slice of `fetch` we use, so tests can pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Minimal MCP (Streamable HTTP) client for Parallel's search server: initializes a session once and reuses it
 * for every `tools/call`. No MCP SDK dependency — the protocol here is three JSON-RPC requests.
 */
export class ParallelMcpClient {
	private sessionId: string | undefined
	private readonly sessionKey = (() => {
		const bytes = new Uint8Array(16)
		crypto.getRandomValues(bytes)
		return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
	})()

	constructor(
		private readonly opts: { apiKey?: string | undefined; fetch?: FetchLike; url?: string } = {},
	) {}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra }
		if (this.sessionId) h["mcp-session-id"] = this.sessionId
		if (this.opts.apiKey) h["authorization"] = `Bearer ${this.opts.apiKey}`
		return h
	}

	private async post(body: unknown): Promise<Response> {
		const doFetch = this.opts.fetch ?? fetch
		try {
			return await doFetch(this.opts.url ?? MCP_URL, { method: "POST", headers: this.headers(), body: JSON.stringify(body) })
		} catch (err) {
			throw classifyError(err)
		}
	}

	private async ensureSession(): Promise<void> {
		if (this.sessionId) return
		const res = await this.post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "mozaik-market-intel", version: "0.1" } },
		})
		if (!res.ok) throw httpError(res)
		const sid = res.headers.get("mcp-session-id")
		if (!sid) throw new ProviderError("unavailable", "Parallel MCP did not return a session id on initialize")
		this.sessionId = sid
		// Fire-and-forget per spec; the server does not reply meaningfully to this notification.
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" })
	}

	async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
		await this.ensureSession()
		const res = await this.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { ...args, session_id: this.sessionKey } } })
		if (res.status === 404 || res.status === 400) {
			// Session expired/unknown on the server side: re-init once and retry.
			this.sessionId = undefined
			await this.ensureSession()
			return this.callOnce(name, args)
		}
		if (!res.ok) throw httpError(res)
		return parseToolResult<T>(await res.json())
	}

	private async callOnce<T>(name: string, args: Record<string, unknown>): Promise<T> {
		const res = await this.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { ...args, session_id: this.sessionKey } } })
		if (!res.ok) throw httpError(res)
		return parseToolResult<T>(await res.json())
	}
}

function httpError(res: Response): ProviderError {
	if (res.status === 429) return new ProviderError("rate_limited", `Parallel MCP: ${res.status} ${res.statusText}`)
	if (res.status === 401 || res.status === 403) return new ProviderError("auth", `Parallel MCP: ${res.status} ${res.statusText}`, { retryable: false })
	if (res.status >= 500) return new ProviderError("unavailable", `Parallel MCP: ${res.status} ${res.statusText}`)
	return new ProviderError("bad_request", `Parallel MCP: ${res.status} ${res.statusText}`, { retryable: false })
}

function parseToolResult<T>(json: JsonRpcResponse): T {
	if (json.error) throw classifyError(new Error(`${json.error.code}: ${json.error.message}`))
	const result = json.result as { isError?: boolean; content?: { type: string; text?: string }[] } | undefined
	const text = result?.content?.find((c) => typeof c.text === "string")?.text
	if (!text) throw new ProviderError("unavailable", "Parallel MCP returned no tool content")
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new ProviderError("unavailable", "Parallel MCP returned non-JSON tool content")
	}
	if (result?.isError) throw classifyError(new Error(typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed)))
	return parsed as T
}

interface ParallelSearchResult {
	url: string
	title?: string | null
	publish_date?: string | null
	excerpts: string[]
}
interface ParallelSearchResponse {
	results: ParallelSearchResult[]
}

const withinDays = (iso: string | null | undefined, days: number | undefined): boolean => {
	if (!days || !iso) return true
	const t = Date.parse(iso)
	if (Number.isNaN(t)) return true
	return Date.now() - t <= days * 24 * 60 * 60 * 1000
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

export class ParallelSearchProvider implements SearchProvider {
	readonly name = "parallel"
	constructor(private readonly client: ParallelMcpClient) {}

	async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
		try {
			const res = await this.client.call<ParallelSearchResponse>("web_search", {
				objective: query.slice(0, 200),
				search_queries: [query],
			})
			return (res.results ?? [])
				.filter((r) => matchesDomains(r.url, opts.includeDomains, opts.excludeDomains) && withinDays(r.publish_date, opts.recencyDays))
				.slice(0, opts.maxResults ?? 5)
				.map((r) => ({
					title: r.title ?? "",
					url: r.url,
					snippet: r.excerpts.join("\n\n"),
					...(r.publish_date ? { publishedAt: r.publish_date } : {}),
				}))
		} catch (err) {
			throw classifyError(err)
		}
	}
}

interface ParallelExtractResult {
	url: string
	title?: string | null
	excerpts: string[]
	full_content?: string | null
}
interface ParallelExtractError {
	url: string
	error_type: string
	http_status_code?: number | null
}
interface ParallelExtractResponse {
	results: ParallelExtractResult[]
	errors: ParallelExtractError[]
}

export class ParallelFetchProvider implements FetchProvider {
	readonly name = "parallel"
	constructor(private readonly client: ParallelMcpClient) {}

	async fetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
		const [r] = await this.fetchMany([url], opts)
		return r ?? { url, title: "", text: "", status: 0, fetchedAt: new Date().toISOString(), error: "empty response" }
	}

	/** Parallel extracts up to 20 URLs in one call, same cap as Tavily. */
	async fetchMany(urls: string[], opts: FetchOptions = {}): Promise<FetchResult[]> {
		try {
			const res = await this.client.call<ParallelExtractResponse>("web_fetch", {
				urls: urls.slice(0, 20),
				full_content: opts.depth === "advanced",
				...(opts.focus ? { objective: opts.focus.slice(0, 200) } : {}),
			})
			const fetchedAt = new Date().toISOString()
			const ok = new Map(res.results.map((r) => [r.url, r]))
			const bad = new Map(res.errors.map((e) => [e.url, e]))
			return urls.map((url): FetchResult => {
				const r = ok.get(url)
				if (r) return { url, title: r.title ?? "", text: r.full_content ?? r.excerpts.join("\n\n"), status: 200, fetchedAt }
				const e = bad.get(url)
				return { url, title: "", text: "", status: e?.http_status_code ?? 0, fetchedAt, error: e?.error_type ?? "not returned by provider" }
			})
		} catch (err) {
			throw classifyError(err)
		}
	}
}

/** Convenience: both Parallel pieces sharing one MCP session. Accountless by default (no API key). */
export function parallelProviders(opts: { apiKey?: string | undefined; fetch?: FetchLike } = {}) {
	const client = new ParallelMcpClient({ apiKey: opts.apiKey ?? process.env.PARALLEL_API_KEY, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
	return { search: new ParallelSearchProvider(client), fetch: new ParallelFetchProvider(client) }
}
