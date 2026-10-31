// Third adapter: You.com's free, accountless "keyless" Search MCP (https://api.you.com/mcp?profile=free). No API
// key needed, 100 free searches/day per the keyless profile. Search-only: the free profile exposes no fetch tool,
// so this provider has no FetchProvider counterpart (Tavily/Parallel still cover web_fetch).
// Verified live (2026-10-31): no session handshake needed — every call is a standalone POST that answers over SSE.
import {
	type ProviderErrorKind,
	ProviderError,
	type SearchOptions,
	type SearchProvider,
	type SearchResult,
	classifyError,
} from "./provider.ts"

const MCP_URL = "https://api.you.com/mcp?profile=free"

/** The slice of `fetch` we use, so tests can pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

function httpError(res: { status: number; statusText: string }): ProviderError {
	const kind: ProviderErrorKind = res.status === 429 ? "rate_limited" : res.status === 401 || res.status === 403 ? "auth" : res.status >= 500 ? "unavailable" : "bad_request"
	return new ProviderError(kind, `You.com MCP: ${res.status} ${res.statusText}`, { retryable: kind !== "auth" && kind !== "bad_request" })
}

/** The keyless endpoint answers over SSE even for a single request/response pair: parse every `data:` line. */
function parseSseResult<T>(text: string): T {
	const blocks = text.split("\n\n").map((block) =>
		block
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim())
			.join(""),
	)
	for (const raw of blocks) {
		if (!raw) continue
		let json: { result?: { content?: { type: string; text?: string }[] }; error?: { code: number; message: string } }
		try {
			json = JSON.parse(raw)
		} catch {
			continue
		}
		if (json.error) throw classifyError(new Error(`${json.error.code}: ${json.error.message}`))
		const item = json.result?.content?.find((c) => typeof c.text === "string")
		if (!item?.text) continue
		try {
			return JSON.parse(item.text) as T
		} catch {
			throw new ProviderError("unavailable", "You.com MCP returned non-JSON tool content")
		}
	}
	throw new ProviderError("unavailable", "You.com MCP returned no result event")
}

/** Minimal MCP client: You.com's keyless endpoint is stateless (no initialize handshake, no session id). */
export class YouMcpClient {
	constructor(private readonly opts: { fetch?: FetchLike; url?: string } = {}) {}

	async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
		const doFetch = this.opts.fetch ?? fetch
		let res: Response
		try {
			res = await doFetch(this.opts.url ?? MCP_URL, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
			})
		} catch (err) {
			throw classifyError(err)
		}
		if (!res.ok) throw httpError(res)
		return parseSseResult<T>(await res.text())
	}
}

interface YouWebResult {
	url: string
	title?: string
	description?: string
	snippets?: string[]
	page_age?: string
	contents?: { highlights?: string[] }
}
interface YouSearchResponse {
	results?: { web?: YouWebResult[] }
}

const freshnessBucket = (days: number | undefined): "day" | "week" | "month" | "year" | undefined =>
	days === undefined ? undefined : days <= 1 ? "day" : days <= 7 ? "week" : days <= 31 ? "month" : "year"

const validDate = (s: string | undefined): string | undefined => {
	if (!s) return undefined
	const t = Date.parse(s)
	return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10)
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

export class YouSearchProvider implements SearchProvider {
	readonly name = "you"
	constructor(private readonly client: YouMcpClient) {}

	async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
		try {
			const freshness = freshnessBucket(opts.recencyDays)
			const res = await this.client.call<YouSearchResponse>("you-search", {
				query: query.slice(0, 400),
				count: Math.min(Math.max(opts.maxResults ?? 10, 1), 100),
				extraction: "highlights",
				...(freshness ? { freshness } : {}),
				...(opts.excludeDomains?.length ? { exclude_domains: opts.excludeDomains } : {}),
			})
			return (res.results?.web ?? [])
				.filter((r) => matchesDomains(r.url, opts.includeDomains, opts.excludeDomains))
				.slice(0, opts.maxResults ?? 5)
				.map((r) => {
					const snippet = (r.contents?.highlights ?? r.snippets ?? [r.description ?? ""]).filter(Boolean).join("\n\n")
					const publishedAt = validDate(r.page_age)
					return { title: r.title ?? "", url: r.url, snippet, ...(publishedAt ? { publishedAt } : {}) }
				})
		} catch (err) {
			throw classifyError(err)
		}
	}
}

/** Convenience: You.com search, accountless by default (the keyless free profile). */
export function youProviders(opts: { fetch?: FetchLike } = {}) {
	const client = new YouMcpClient(opts.fetch ? { fetch: opts.fetch } : {})
	return { search: new YouSearchProvider(client) }
}
