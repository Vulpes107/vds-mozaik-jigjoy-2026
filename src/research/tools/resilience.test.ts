import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileCache, LayeredCache, MemoryCache, cacheKey, stableStringify } from "./cache.ts"
import { ProviderError, classifyError } from "./provider.ts"
import { BudgetStop, RateLimiter, type RetryPolicy, withRetry } from "./resilience.ts"
import { CallBudget } from "./usage.ts"

const policy = (attempts: number, sleeps: number[] = []): RetryPolicy => ({
	attempts, baseMs: 100, maxMs: 1000, random: () => 0,
	sleep: async (ms) => void sleeps.push(ms),
})

test("retries transient errors with growing backoff, then succeeds", async () => {
	let n = 0
	const sleeps: number[] = []
	const r = await withRetry(async () => {
		if (++n < 3) throw new ProviderError("unavailable", "503")
		return "ok"
	}, policy(4, sleeps))
	assert.equal(r.value, "ok")
	assert.equal(r.attempts, 3)
	assert.equal(sleeps.length, 2)
	assert.ok(sleeps[1]! > sleeps[0]!)
})

test("gives up after the last attempt and rethrows a ProviderError", async () => {
	let n = 0
	await assert.rejects(withRetry(async () => { n++; throw new Error("503 Service Unavailable") }, policy(3)), (e: unknown) => e instanceof ProviderError && e.kind === "unavailable")
	assert.equal(n, 3)
})

test("non-retryable errors are not retried", async () => {
	let n = 0
	await assert.rejects(withRetry(async () => { n++; throw new Error("401 Unauthorized: invalid api key") }, policy(5)))
	assert.equal(n, 1)
})

test("Retry-After is honoured", async () => {
	const sleeps: number[] = []
	let n = 0
	await withRetry(async () => {
		if (n++ === 0) throw new ProviderError("rate_limited", "429", { retryAfterMs: 5000 })
		return 1
	}, policy(2, sleeps))
	assert.ok(sleeps[0]! >= 5000)
})

test("error classification from SDK-style messages", () => {
	assert.equal(classifyError(new Error("429 Error: usage limit exceeded")).kind, "rate_limited")
	assert.equal(classifyError(new Error("Request timed out after 60 seconds.")).kind, "timeout")
	assert.equal(classifyError(new Error("502 Error: bad gateway")).kind, "unavailable")
	assert.equal(classifyError(new Error("401 Error: unauthorized")).retryable, false)
	assert.equal(classifyError(new Error("something odd")).retryable, false)
})

test("a budget stop is not retried and carries its scope", async () => {
	const budget = new CallBudget({ topicCalls: () => 2, runCalls: () => undefined })
	let calls = 0
	const p: RetryPolicy = { ...policy(5), beforeAttempt: () => budget.charge("t_001") }
	await assert.rejects(withRetry(async () => { calls++; throw new ProviderError("unavailable", "503") }, p), (e: unknown) => e instanceof BudgetStop && e.scope === "topic")
	assert.equal(calls, 2)
})

test("call budget enforces per-topic and run limits, independently per topic", () => {
	const b = new CallBudget({ topicCalls: (id) => (id === "t_a" ? 1 : undefined), runCalls: () => 3 })
	b.charge("t_a")
	assert.throws(() => b.charge("t_a"), BudgetStop)
	b.charge("t_b")
	b.charge("t_b")
	assert.throws(() => b.charge("t_b"), (e: unknown) => e instanceof BudgetStop && e.scope === "run")
	assert.equal(b.totalUsed, 3)
})

test("rate limiter caps concurrency and spaces call starts", async () => {
	let active = 0
	let peak = 0
	const starts: number[] = []
	let clock = 0
	const lim = new RateLimiter({ maxConcurrent: 2, minIntervalMs: 50 }, async (ms) => { clock += ms }, () => clock)
	await Promise.all(Array.from({ length: 6 }, () => lim.run(async () => {
		starts.push(clock)
		active++
		peak = Math.max(peak, active)
		await new Promise((r) => setTimeout(r, 5))
		active--
	})))
	assert.ok(peak <= 2)
	for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 0)
	assert.ok(starts[5]! >= 250 - 1, `starts ${starts}`)
})

test("cache keys are stable across key order and sensitive to arguments and tool", () => {
	assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] }), stableStringify({ a: [2, { d: 1 }], b: 1 }))
	assert.equal(cacheKey("search", { q: "x", n: 1 }), cacheKey("search", { n: 1, q: "x" }))
	assert.notEqual(cacheKey("search", { q: "x" }), cacheKey("fetch", { q: "x" }))
	assert.notEqual(cacheKey("search", { q: "x" }), cacheKey("search", { q: "y" }))
})

test("file cache round-trips and layered cache promotes to memory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "b-cache-"))
	try {
		const file = new FileCache(dir)
		await file.set("k1", { value: { a: 1 }, storedAt: 5 })
		assert.deepEqual(await file.get("k1"), { value: { a: 1 }, storedAt: 5 })
		assert.equal(await file.get("missing"), undefined)
		const layered = new LayeredCache(file)
		assert.deepEqual((await layered.get("k1"))?.value, { a: 1 })
		const mem = new MemoryCache()
		await mem.set("x", { value: 1, storedAt: 1 })
		assert.equal(mem.size, 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
