import { test } from "node:test"
import assert from "node:assert/strict"
import { ProviderError } from "./provider.ts"
import { FirecrawlFetchProvider, firecrawlProviders, type FetchLike } from "./firecrawl.ts"

const fakeServer = (handlers: { onSearch?: (body: any) => unknown; onScrape?: (body: any) => unknown; status?: number } = {}): { fetch: FetchLike; calls: { path: string; body: any }[] } => {
	const calls: { path: string; body: any }[] = []
	const fetch: FetchLike = async (url, init) => {
		const path = new URL(String(url)).pathname
		const body = JSON.parse(String(init.body))
		calls.push({ path, body })
		if (handlers.status && handlers.status !== 200) return new Response(JSON.stringify({ success: false, error: "boom" }), { status: handlers.status, statusText: "err" })
		if (path.endsWith("/search")) return new Response(JSON.stringify({ success: true, data: { web: handlers.onSearch?.(body) ?? [] } }), { status: 200 })
		if (path.endsWith("/scrape")) return new Response(JSON.stringify({ success: true, data: handlers.onScrape?.(body) ?? {} }), { status: 200 })
		throw new Error(`unexpected path ${path}`)
	}
	return { fetch, calls }
}

test("search sends query+limit and maps web results, domain-filtered", async () => {
	const { fetch, calls } = fakeServer({
		onSearch: () => [
			{ url: "https://a.example", title: "A", description: "desc a" },
			{ url: "https://excluded.example", title: "B", description: "desc b" },
		],
	})
	const provider = firecrawlProviders({ fetch }).search
	const results = await provider.search("q", { maxResults: 5, excludeDomains: ["excluded.example"] })
	assert.deepEqual(results, [{ title: "A", url: "https://a.example", snippet: "desc a" }])
	assert.equal(calls[0]!.body.query, "q")
	assert.equal(calls[0]!.body.limit, 5)
})

test("fetch (scrape) maps markdown, title and status, and 404s become a clean FetchResult", async () => {
	const { fetch } = fakeServer({ onScrape: () => ({ markdown: "# hi", metadata: { title: "Hi", statusCode: 200 } }) })
	const provider = firecrawlProviders({ fetch }).fetch
	const ok = await provider.fetch("https://a.example")
	assert.deepEqual([ok.status, ok.title, ok.text], [200, "Hi", "# hi"])

	const notFound = new FirecrawlFetchProvider({ post: async () => { throw Object.assign(new Error("404 not found"), {}) } } as any)
	const r = await notFound.fetch("https://missing.example")
	assert.equal(r.status, 404)
	assert.equal(r.text, "")
})

test("fetchMany runs scrapes concurrently and preserves input order", async () => {
	const { fetch, calls } = fakeServer({ onScrape: (body) => ({ markdown: `md:${body.url}`, metadata: { title: body.url } }) })
	const provider = firecrawlProviders({ fetch }).fetch
	const out = await provider.fetchMany(["https://a.example", "https://b.example"])
	assert.deepEqual(out.map((r) => r.text), ["md:https://a.example", "md:https://b.example"])
	assert.equal(calls.length, 2)
})

test("HTTP 429 is classified as rate_limited and retryable", async () => {
	const { fetch } = fakeServer({ status: 429 })
	await assert.rejects(
		firecrawlProviders({ fetch }).search.search("q"),
		(e: unknown) => e instanceof ProviderError && e.kind === "rate_limited" && e.retryable,
	)
})

test("no key, no account: the request carries no authorization header by default", async () => {
	let sawAuth = false
	const fetch: FetchLike = async (url, init) => {
		if ((init.headers as Record<string, string>)["authorization"]) sawAuth = true
		const path = new URL(String(url)).pathname
		return new Response(JSON.stringify({ success: true, data: path.endsWith("/search") ? { web: [] } : {} }), { status: 200 })
	}
	await firecrawlProviders({ fetch }).search.search("q")
	assert.equal(sawAuth, false)
})

test("an explicit apiKey is sent as a bearer token", async () => {
	let auth: string | undefined
	const fetch: FetchLike = async (_url, init) => {
		auth = (init.headers as Record<string, string>)["authorization"]
		return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 })
	}
	await firecrawlProviders({ fetch, apiKey: "fc_test" }).search.search("q")
	assert.equal(auth, "Bearer fc_test")
})
