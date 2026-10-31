import { test } from "node:test"
import assert from "node:assert/strict"
import {
	assessFreshness, canonicalUrl, classifyDomain, finalConfidence, findConflicts, independentOrigins, metricTag,
	normalizeUnit, normalizeValue, resolveSourceType, scoreReliability, topicConfidence,
} from "./scoring.ts"
import { NOW } from "./testkit.ts"
import type { Obj } from "../shared/runtime.ts"

test("domains classify and strong domain evidence overrides the model's guess", () => {
	assert.equal(classifyDomain("https://www.sec.gov/cgi-bin/x"), "regulator")
	assert.equal(classifyDomain("https://pmc.ncbi.nlm.nih.gov/articles/PMC123"), "analyst_report") // a study on a .gov archive is research, not a regulator
	assert.equal(resolveSourceType("https://pubmed.ncbi.nlm.nih.gov/123", "regulator"), "analyst_report")
	assert.equal(classifyDomain("https://www.appbrain.com/stats"), "analyst_report")
	assert.equal(classifyDomain("https://ec.europa.eu/x"), "regulator")
	assert.equal(classifyDomain("https://old.reddit.com/r/x"), "forum")
	assert.equal(classifyDomain("https://acme.example/pricing"), undefined)
	assert.equal(classifyDomain("https://play.google.com/store/apps/details?id=x"), "primary")
	assert.equal(classifyDomain("https://www.sensortower.com/blog/x"), "analyst_report")
	assert.equal(classifyDomain("https://cs.stanford.edu/x"), "analyst_report")
	assert.equal(classifyDomain("https://www.theverge.com/x"), "news")
	assert.equal(resolveSourceType("https://old.reddit.com/r/x", "primary"), "forum")
	assert.equal(resolveSourceType("https://data.gov.rs/x", "blog"), "regulator")
	assert.equal(resolveSourceType("https://acme.example/pricing", "vendor"), "vendor")
	assert.equal(resolveSourceType("https://acme.example/x"), "other")
})

test("reliability ranks primary above news above blog, and penalises flags, secondhand and SEO pages", () => {
	const base = { url: "https://x.example/a", now: NOW }
	const reg = scoreReliability({ ...base, type: "regulator" })
	const news = scoreReliability({ ...base, type: "news" })
	const blog = scoreReliability({ ...base, type: "blog" })
	assert.ok(reg > news && news > blog)
	assert.ok(scoreReliability({ ...base, type: "news", injectionFlagged: true }) < news)
	assert.ok(scoreReliability({ ...base, type: "news", secondhand: true }) < news)
	assert.ok(scoreReliability({ url: "https://x.example/best-tools-top-10", type: "blog", now: NOW }) < blog)
	assert.ok(scoreReliability({ ...base, type: "news", publishedAt: "2019-01-01" }) < news)
	for (const v of [reg, news, blog]) assert.ok(v >= 0 && v <= 1)
})

test("canonical URLs ignore tracking params, fragments, host case and trailing slash", () => {
	assert.equal(canonicalUrl("https://Example.com/a/?utm_source=x&b=2&a=1#frag"), canonicalUrl("https://example.com/a?a=1&b=2"))
	assert.notEqual(canonicalUrl("https://example.com/a"), canonicalUrl("https://example.com/b"))
})

test("freshness: recent is fine, ageing reduces the factor, old is stale; pricing ages faster than regulation", () => {
	assert.deepEqual({ ...assessFreshness("2026-06-01", NOW, "pricing") , ageYears: 0 }, { stale: false, factor: 1, ageYears: 0 })
	const mid = assessFreshness("2025-12-01", NOW, "pricing")
	assert.equal(mid.stale, false)
	assert.ok(mid.factor < 1)
	assert.equal(assessFreshness("2023-01-01", NOW, "pricing").stale, true)
	assert.equal(assessFreshness("2024-01-01", NOW, "regulation").stale, false)
	assert.ok(assessFreshness("2018-01-01", NOW, "market").factor >= 0.4)
})

test("final confidence is capped by type, best source and penalties, and verification lifts it", () => {
	const base = { modelConfidence: 0.95, type: "fact" as const, sourceReliabilities: [0.9], independentOrigins: 2, freshnessFactor: 1, anyInjectionFlagged: false, verified: false }
	assert.equal(finalConfidence(base), 0.95)
	assert.ok(finalConfidence({ ...base, type: "estimate" }) <= 0.7)
	assert.ok(finalConfidence({ ...base, type: "opinion" }) <= 0.5)
	assert.ok(finalConfidence({ ...base, sourceReliabilities: [0.3] }) <= 0.4)
	assert.ok(finalConfidence({ ...base, independentOrigins: 1 }) < finalConfidence(base))
	assert.ok(finalConfidence({ ...base, anyInjectionFlagged: true }) < finalConfidence(base))
	assert.ok(finalConfidence({ ...base, freshnessFactor: 0.5 }) < finalConfidence(base))
	assert.ok(finalConfidence({ ...base, type: "estimate", verified: true }) > finalConfidence({ ...base, type: "estimate" }))
	assert.ok(finalConfidence({ ...base, modelConfidence: 5 }) <= 1)
})

test("independent origins: many articles citing one report count once", () => {
	const sources = new Map<string, Obj>([
		["s_001", { id: "s_001" }],
		["s_002", { id: "s_002", origin_id: "s_001" }],
		["s_003", { id: "s_003", origin_id: "s_001" }],
		["s_004", { id: "s_004" }],
	])
	assert.equal(independentOrigins(["s_002", "s_003"], sources).size, 1)
	assert.equal(independentOrigins(["s_001", "s_002", "s_003"], sources).size, 1)
	assert.equal(independentOrigins(["s_002", "s_004"], sources).size, 2)
})

test("topic confidence needs coverage and favours verified findings", () => {
	const f = (c: number, verified = false): Obj => ({ id: "f", confidence: c, verified })
	assert.equal(topicConfidence([], 3), 0)
	assert.ok(topicConfidence([f(0.9)], 5) < topicConfidence([f(0.9), f(0.9), f(0.9), f(0.9), f(0.9)], 5))
	assert.ok(topicConfidence([f(0.9, true), f(0.4)], 2) > topicConfidence([f(0.9), f(0.4, true)], 2))
})

test("units: aliases, scales are applied in code, and money converts only with a supplied rate", () => {
	assert.equal(normalizeUnit("euro"), "EUR")
	assert.equal(normalizeUnit("usd/user/month"), "USD/user/month")
	assert.equal(normalizeUnit("percent"), "%")
	assert.deepEqual(normalizeValue({ value: 1.2, unit: "eur", scale: "million" }, { profileCurrency: "EUR" }), { value: 1_200_000, unit: "EUR", tags: [] })
	const withRate = normalizeValue({ value: 2, unit: "USD", scale: "million" }, { profileCurrency: "EUR", fxRates: { USD: 0.9 } })
	assert.equal(withRate.value, 1_800_000)
	assert.equal(withRate.unit, "EUR")
	assert.ok(withRate.tags.some((t) => t.startsWith("fx:USD->EUR@0.9")) && withRate.tags.some((t) => t.startsWith("orig:")))
	const noRate = normalizeValue({ value: 2, unit: "USD" }, { profileCurrency: "EUR" })
	assert.deepEqual(noRate, { value: 2, unit: "USD", tags: ["fx_unconverted"] })
	assert.deepEqual(normalizeValue({ value: 12, unit: "percent" }, { profileCurrency: "EUR" }), { value: 12, unit: "%", tags: [] })
})

test("conflicts: same topic, metric and unit, values far apart", () => {
	const tag = metricTag("Vendor X entry price")
	const f = (id: string, value: number, extra: Partial<Obj> = {}): Obj => ({ id, topic_id: "t_001", value, unit: "EUR", tags: [tag], ...extra })
	assert.deepEqual(findConflicts(f("f_002", 80), [f("f_001", 49)]), ["f_001"])
	assert.deepEqual(findConflicts(f("f_002", 50), [f("f_001", 49)]), [])
	assert.deepEqual(findConflicts(f("f_002", 80), [f("f_001", 49, { unit: "USD" })]), [])
	assert.deepEqual(findConflicts(f("f_002", 80), [f("f_001", 49, { topic_id: "t_009" })]), [])
	assert.deepEqual(findConflicts(f("f_002", 80), [f("f_001", 49, { tags: [] })]), [])
})
