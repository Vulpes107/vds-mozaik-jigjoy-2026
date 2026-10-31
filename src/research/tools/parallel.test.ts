import { test } from "node:test"
import assert from "node:assert/strict"
import { ProviderError } from "./provider.ts"
import { ParallelFetchProvider, ParallelMcpClient, ParallelSearchProvider, type FetchLike } from "./parallel.ts"

/** A fake Streamable-HTTP MCP server: initialize -> session id header, then tools/call dispatches to a handler. */
const fakeServer = (handlers: { onCall?: (name: string, args: any) => unknown; status?: number } = {}): { fetch: FetchLike; calls: { method: string; body: any }[] } => {
	const calls: { method: string; body: any }[] = []
	const fetch: FetchLike = async (_url, init) => {
		const body = JSON.parse(String(init.body))
		calls.push({ method: body.method, body })
		if (body.method === "initialize") {
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "mcp-session-id": "sess-123" } })
		}
		if (body.method === "notifications/initialized") {
			return new Response("", { status: 202 })
		}
		if (body.method === "tools/call") {
			if (handlers.status && handlers.status !== 200) return new Response("", { status: handlers.status, statusText: "err" })
			const result = handlers.onCall?.(body.params.name, body.params.arguments) ?? {}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }), { status: 200 })
		}
		throw new Error(`unexpected method ${body.method}`)
	}
	return { fetch, calls }
}

test("search initializes a session once, sends objective+search_queries, and maps results", async () => {
	const { fetch, calls } = fakeServer({
		onCall: (name, args) => {
			assert.equal(name, "web_search")
			assert.ok(typeof args.session_id === "string" && args.session_id.length >= 32)
			return {
				search_id: "s1",
				session_id: "sess-echo",
				results: [
					{ url: "https://a.example", title: "A", publish_date: "2026-03-01", excerpts: ["one", "two"] },
					{ url: "https://b.example", title: null, publish_date: null, excerpts: ["three"] },
				],
			}
		},
	})
	const client = new ParallelMcpClient({ fetch })
	const out = await new ParallelSearchProvider(client).search("q")
	const firstArgs = calls[2]!.body.params.arguments
	assert.equal(firstArgs.objective, "q")
	assert.deepEqual(firstArgs.search_queries, ["q"])
	assert.deepEqual(out, [
		{ title: "A", url: "https://a.example", snippet: "one\n\ntwo", publishedAt: "2026-03-01" },
		{ title: "", url: "https://b.example", snippet: "three" },
	])
	assert.deepEqual(calls.map((c) => c.method), ["initialize", "notifications/initialized", "tools/call"])

	// A second search reuses the session: no new initialize call.
	await new ParallelSearchProvider(client).search("q2")
	assert.deepEqual(calls.map((c) => c.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"])
})

test("search filters by domain and recency client-side and caps at maxResults", async () => {
	const { fetch } = fakeServer({
		onCall: () => ({
			results: [
				{ url: "https://old.example", title: "Old", publish_date: "2000-01-01", excerpts: ["x"] },
				{ url: "https://keep.example", title: "Keep", publish_date: new Date().toISOString().slice(0, 10), excerpts: ["y"] },
				{ url: "https://excluded.example", title: "Ex", publish_date: new Date().toISOString().slice(0, 10), excerpts: ["z"] },
			],
		}),
	})
	const client = new ParallelMcpClient({ fetch })
	const out = await new ParallelSearchProvider(client).search("q", { recencyDays: 7, excludeDomains: ["excluded.example"], maxResults: 1 })
	assert.deepEqual(out.map((r) => r.url), ["https://keep.example"])
})

test("fetchMany batches one call, maps successes and errors, preserves input order", async () => {
	const { fetch, calls } = fakeServer({
		onCall: (name, args) => {
			assert.equal(name, "web_fetch")
			assert.deepEqual(args.urls, ["https://a.example", "https://b.example"])
			return {
				results: [{ url: "https://a.example", title: "A", excerpts: ["hello"] }],
				errors: [{ url: "https://b.example", error_type: "not_found", http_status_code: 404 }],
			}
		},
	})
	const out = await new ParallelFetchProvider(new ParallelMcpClient({ fetch })).fetchMany(["https://a.example", "https://b.example"])
	assert.equal(calls.filter((c) => c.method === "tools/call").length, 1)
	assert.deepEqual(out.map((r) => [r.url, r.status, r.text || r.error]), [
		["https://a.example", 200, "hello"],
		["https://b.example", 404, "not_found"],
	])
})

test("HTTP errors are classified as ProviderErrors (429 -> rate_limited, retryable)", async () => {
	const { fetch } = fakeServer({ status: 429 })
	await assert.rejects(
		new ParallelSearchProvider(new ParallelMcpClient({ fetch })).search("q"),
		(e: unknown) => e instanceof ProviderError && e.kind === "rate_limited" && e.retryable,
	)
})

test("no API key is required: the client never sends an authorization header by default", async () => {
	let sawAuth = false
	const fetch: FetchLike = async (_url, init) => {
		if ((init.headers as Record<string, string>)["authorization"]) sawAuth = true
		const body = JSON.parse(String(init.body))
		if (body.method === "initialize") return new Response("{}", { status: 200, headers: { "mcp-session-id": "s" } })
		if (body.method === "notifications/initialized") return new Response("", { status: 202 })
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "{\"results\":[]}" }] } }), { status: 200 })
	}
	await new ParallelSearchProvider(new ParallelMcpClient({ fetch })).search("q")
	assert.equal(sawAuth, false)
})
