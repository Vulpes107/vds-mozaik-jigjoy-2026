import { test } from "node:test"
import assert from "node:assert/strict"
import { ProviderError } from "./provider.ts"
import { YouMcpClient, YouSearchProvider, type FetchLike } from "./you.ts"

/** You.com's keyless MCP is stateless (no initialize) and answers over SSE, even for one tool call. */
const sse = (result: unknown): string => `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`

const fakeServer = (opts: { onCall?: (name: string, args: any) => unknown; status?: number } = {}): { fetch: FetchLike; calls: any[] } => {
	const calls: any[] = []
	const fetch: FetchLike = async (_url, init) => {
		const body = JSON.parse(String(init.body))
		calls.push(body.params.arguments)
		if (opts.status && opts.status !== 200) return new Response("", { status: opts.status, statusText: "err" })
		const value = opts.onCall?.(body.params.name, body.params.arguments) ?? {}
		const text = sse({ content: [{ type: "text", text: JSON.stringify(value) }] })
		return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
	}
	return { fetch, calls }
}

test("search sends a bounded query and count, and maps web results", async () => {
	const { fetch, calls } = fakeServer({
		onCall: (name, args) => {
			assert.equal(name, "you-search")
			return {
				results: {
					web: [
						{ url: "https://a.example", title: "A", page_age: "2026-03-01", contents: { highlights: ["h1", "h2"] } },
						{ url: "https://b.example", title: "B", description: "fallback desc" },
					],
				},
			}
		},
	})
	const out = await new YouSearchProvider(new YouMcpClient({ fetch })).search("q", { maxResults: 5 })
	assert.deepEqual(out, [
		{ title: "A", url: "https://a.example", snippet: "h1\n\nh2", publishedAt: "2026-03-01" },
		{ title: "B", url: "https://b.example", snippet: "fallback desc" },
	])
	assert.equal(calls[0]!.query, "q")
	assert.equal(calls[0]!.count, 5)
})

test("domain filters and maxResults are applied client-side", async () => {
	const { fetch } = fakeServer({
		onCall: () => ({
			results: { web: [{ url: "https://keep.example", title: "K" }, { url: "https://drop.example", title: "D" }] },
		}),
	})
	const out = await new YouSearchProvider(new YouMcpClient({ fetch })).search("q", { excludeDomains: ["drop.example"] })
	assert.deepEqual(out.map((r) => r.url), ["https://keep.example"])
})

test("HTTP 429 is classified as rate_limited and retryable", async () => {
	const { fetch } = fakeServer({ status: 429 })
	await assert.rejects(
		new YouSearchProvider(new YouMcpClient({ fetch })).search("q"),
		(e: unknown) => e instanceof ProviderError && e.kind === "rate_limited" && e.retryable,
	)
})

test("a JSON-RPC error in the SSE stream is classified", async () => {
	const fetch: FetchLike = async () =>
		new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "usage limit exceeded" } })}\n\n`, { status: 200 })
	await assert.rejects(
		new YouSearchProvider(new YouMcpClient({ fetch })).search("q"),
		(e: unknown) => e instanceof ProviderError && e.kind === "rate_limited",
	)
})

test("no key, no account: the request carries no authorization header", async () => {
	let sawAuth = false
	const fetch: FetchLike = async (_url, init) => {
		if ((init.headers as Record<string, string>)["authorization"]) sawAuth = true
		return new Response(sse({ content: [{ type: "text", text: "{\"results\":{}}" }] }), { status: 200 })
	}
	await new YouSearchProvider(new YouMcpClient({ fetch })).search("q")
	assert.equal(sawAuth, false)
})
