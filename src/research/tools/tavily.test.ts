import { test } from "node:test"
import assert from "node:assert/strict"
import { ProviderError } from "./provider.ts"
import { TavilyExtras, TavilyFetchProvider, TavilySearchProvider, type TavilyLike, createTavilyClient } from "./tavily.ts"

const fake = (over: Partial<Record<keyof TavilyLike, (...a: any[]) => any>> = {}): TavilyLike & { calls: Record<string, any[]> } => {
	const calls: Record<string, any[]> = {}
	const rec = (name: string, fn: (...a: any[]) => any) => (...a: any[]) => { (calls[name] ??= []).push(a); return fn(...a) }
	return {
		calls,
		search: rec("search", over.search ?? (async () => ({ results: [] }))),
		extract: rec("extract", over.extract ?? (async () => ({ results: [], failedResults: [] }))),
		map: rec("map", over.map ?? (async () => ({ results: [] }))),
		crawl: rec("crawl", over.crawl ?? (async () => ({ results: [] }))),
		research: rec("research", over.research ?? (async () => ({ requestId: "r1", status: "pending" }))),
		getResearch: rec("getResearch", over.getResearch ?? (async () => ({ status: "completed", content: "c", sources: [] }))),
	} as any
}

test("search maps options and results to the provider-neutral shape", async () => {
	const c = fake({ search: async () => ({ results: [
		{ title: "T", url: "https://a.example", content: "snippet", publishedDate: "2026-03-04T10:00:00Z" },
		{ title: "U", url: "https://b.example", content: "s2", publishedDate: "garbage" },
	] }) })
	const out = await new TavilySearchProvider(c).search("q", { maxResults: 3, depth: "advanced", recencyDays: 20, includeDomains: ["a.example"], kind: "news" })
	assert.deepEqual(out, [
		{ title: "T", url: "https://a.example", snippet: "snippet", publishedAt: "2026-03-04" },
		{ title: "U", url: "https://b.example", snippet: "s2" },
	])
	const opts = c.calls.search![0]![1]
	assert.deepEqual({ d: opts.searchDepth, n: opts.maxResults, t: opts.topic, r: opts.timeRange, dom: opts.includeDomains, a: opts.includeAnswer }, { d: "advanced", n: 3, t: "news", r: "month", dom: ["a.example"], a: false })
})

test("search errors become classified ProviderErrors", async () => {
	const c = fake({ search: async () => { throw new Error("429 Error: usage limit exceeded") } })
	await assert.rejects(new TavilySearchProvider(c).search("q"), (e: unknown) => e instanceof ProviderError && e.kind === "rate_limited" && e.retryable)
})

test("extract is batched in one call and results come back in input order, failures mapped", async () => {
	const c = fake({ extract: async () => ({
		results: [{ url: "https://b.example", title: "B", rawContent: "bbb" }, { url: "https://a.example", title: null, rawContent: "aaa" }],
		failedResults: [{ url: "https://c.example", error: "404 not found" }, { url: "https://d.example", error: "blocked by robots" }],
	}) })
	const out = await new TavilyFetchProvider(c).fetchMany(["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example"])
	assert.equal(c.calls.extract!.length, 1)
	assert.deepEqual(out.map((r) => [r.url, r.status, r.text]), [
		["https://a.example", 200, "aaa"], ["https://b.example", 200, "bbb"], ["https://c.example", 404, ""], ["https://d.example", 403, ""], ["https://e.example", 0, ""],
	])
	assert.equal(out[0]!.title, "")
})

test("extract passes a focus query and never sends more than 20 URLs", async () => {
	const c = fake()
	const urls = Array.from({ length: 30 }, (_, i) => `https://a.example/${i}`)
	await new TavilyFetchProvider(c).fetchMany(urls, { focus: "pricing tiers", depth: "advanced" })
	const [sent, opts] = c.calls.extract![0]!
	assert.equal(sent.length, 20)
	assert.equal(opts.query, "pricing tiers")
	assert.equal(opts.extractDepth, "advanced")
})

test("map and crawl pass their caps through and never allow external domains", async () => {
	const c = fake({ map: async () => ({ results: ["https://a.example/p"] }), crawl: async () => ({ results: [{ url: "https://a.example/p", rawContent: "txt" }] }) })
	const x = new TavilyExtras(c)
	assert.deepEqual(await x.map("https://a.example", { limit: 10, maxDepth: 2, selectPaths: ["/pricing.*"] }), ["https://a.example/p"])
	assert.deepEqual(await x.crawl("https://a.example", { pageLimit: 4, maxDepth: 1 }), [{ url: "https://a.example/p", text: "txt" }])
	const crawlOpts = c.calls.crawl![0]![1]
	assert.deepEqual({ l: crawlOpts.limit, e: crawlOpts.allowExternal, f: crawlOpts.format }, { l: 4, e: false, f: "markdown" })
	assert.deepEqual(c.calls.map![0]![1].selectPaths, ["/pricing.*"])
})

test("research polls until completed", async () => {
	let polls = 0
	const c = fake({ getResearch: async () => (++polls < 3 ? { status: "in_progress" } : { status: "completed", content: "The report.", sources: [{ title: "S", url: "https://a.example" }] }) })
	const slept: number[] = []
	const out = await new TavilyExtras(c, async (ms) => void slept.push(ms), 10, 10).research("q")
	assert.equal(out.content, "The report.")
	assert.equal(polls, 3)
	assert.equal(slept.length, 2)
	assert.equal(c.calls.research![0]![1].stream, false)
})

test("research that never finishes times out as a retryable ProviderError; a failed one is unavailable", async () => {
	const never = fake({ getResearch: async () => ({ status: "in_progress" }) })
	await assert.rejects(new TavilyExtras(never, async () => {}, 1, 3).research("q"), (e: unknown) => e instanceof ProviderError && e.kind === "timeout")
	const failed = fake({ getResearch: async () => ({ status: "failed" }) })
	await assert.rejects(new TavilyExtras(failed, async () => {}, 1, 3).research("q"), (e: unknown) => e instanceof ProviderError && e.kind === "unavailable")
})

test("a missing API key is a clear, non-retryable configuration error", () => {
	const saved = process.env.TAVILY_API_KEY
	delete process.env.TAVILY_API_KEY
	try {
		assert.throws(() => createTavilyClient(), (e: unknown) => e instanceof ProviderError && e.kind === "auth" && !e.retryable && /TAVILY_API_KEY/.test(e.message))
	} finally {
		if (saved !== undefined) process.env.TAVILY_API_KEY = saved
	}
})
