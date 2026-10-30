import { test } from "node:test"
import assert from "node:assert/strict"
import { LiveRedactor, Redactor } from "./redact.ts"
import { profile } from "../testkit.ts"

const r = () => new Redactor(profile())

test("company name, legal-form-less name and unreleased product are stripped", () => {
	const out = r().redactQuery("Demo Logistics d.o.o. RouteGenius route optimisation competitors Serbia")
	assert.ok(!/demo|logistics d|routegenius/i.test(out.text.replace(/logistics/i, "")), out.text)
	assert.match(out.text, /route optimisation competitors Serbia/)
	assert.ok(out.redactions.includes("confidential_term"))
	assert.equal(out.rejected, undefined)
})

test("bare company name without the legal suffix is also stripped", () => {
	const out = r().redactQuery("is Demo Logistics growing in Serbia")
	assert.ok(!/demo logistics/i.test(out.text), out.text)
})

test("internal figures are removed however they are written", () => {
	for (const q of ["market share of a 1800000 EUR courier", "courier with 1,800,000 revenue", "firms near 1.8M turnover", "firms near 1.8 million turnover", "cash 300k runway", "budget of 150 000 for routing software"]) {
		const out = r().redactQuery(q)
		assert.ok(out.redactions.includes("internal_figure"), q)
		assert.ok(!/1800000|1,800,000|1\.8|300k|150 000|150000/.test(out.text), `${q} -> ${out.text}`)
	}
})

test("public numbers that merely look similar are kept", () => {
	const out = r().redactQuery("European parcel market 2025 growth 12% EUR 90 billion")
	assert.equal(out.text, "European parcel market 2025 growth 12% EUR 90 billion")
	assert.deepEqual(out.redactions, [])
})

test("verbatim copies of the user's notes and private segments are removed", () => {
	const a = r().redactQuery("quietly negotiating an acquisition of Bravo Couriers next quarter logistics")
	assert.ok(!/acquisition of Bravo/i.test(a.text), a.text)
	assert.ok(a.redactions.includes("profile_notes"))
	const b = r().redactQuery("what does project falcon mean for couriers")
	assert.ok(!/falcon/i.test(b.text), b.text)
	assert.ok(b.redactions.includes("private_notes") || b.redactions.includes("confidential_term"))
})

test("emails, phone numbers and IBANs never leave", () => {
	const out = r().redactQuery("contact ceo@demo-logistics.rs +381 11 555 1234 RS35260005601001611379 parcel lockers")
	assert.ok(!/@|381|RS35/.test(out.text), out.text)
	assert.match(out.text, /parcel lockers/)
})

test("year lists and ranges are not mistaken for phone numbers", () => {
	assert.equal(r().redactQuery("parcel market 2024 2025 2026 forecast Serbia").text, "parcel market 2024 2025 2026 forecast Serbia")
	assert.equal(r().redactQuery("courier growth 2020-2030 outlook").text, "courier growth 2020-2030 outlook")
	assert.ok(!/381|555/.test(r().redactQuery("call +381 11 555 1234 courier tenders").text))
})

test("an internal figure written right after a year is still caught", () => {
	for (const q of ["revenue 2025 1800000 couriers Serbia", "benchmark in 2025 150 000 budget couriers Serbia", "turnover 2024 1.8M EUR couriers Serbia"]) {
		const out = r().redactQuery(q)
		assert.ok(out.redactions.includes("internal_figure"), q)
		assert.ok(/2024|2025/.test(out.text), `the year survives: ${out.text}`)
		assert.ok(!/1800000|150 000|1\.8M/.test(out.text), out.text)
	}
})

test("a query that is only confidential details is refused, not sent half-empty", () => {
	const out = r().redactQuery("Demo Logistics RouteGenius")
	assert.ok(out.rejected)
	assert.equal(out.text, "")
})

test("brand topics may use the public company name; unreleased products stay hidden", () => {
	const out = r().redactQuery("Demo Logistics reviews RouteGenius", { category: "brand" })
	assert.match(out.text, /Demo Logistics reviews/)
	assert.ok(!/RouteGenius/.test(out.text))
})

test("launched product names are only allowed on brand topics", () => {
	assert.ok(!/Express Delivery/.test(r().redactQuery("Express Delivery pricing competitors Serbia", { category: "pricing" }).text))
	assert.match(r().redactQuery("Express Delivery customer reviews Serbia", { category: "brand" }).text, /Express Delivery/)
})

test("URLs that smuggle confidential terms are refused", () => {
	assert.equal(r().checkUrl("https://example.com/search?q=Demo+Logistics").ok, false)
	assert.equal(r().checkUrl("https://example.com/demo-logistics-leak").ok, false)
	assert.equal(r().checkUrl("https://example.com/pricing").ok, true)
})

test("extra confidential terms (e.g. customer names) are stripped", () => {
	const red = new Redactor(profile(), ["Acme Retail"])
	const out = red.redactQuery("Acme Retail delivery contract benchmark Serbia")
	assert.ok(!/acme/i.test(out.text), out.text)
})

test("LiveRedactor follows a profile that is replaced after construction", () => {
	let p: ReturnType<typeof profile> | undefined
	const live = new LiveRedactor(() => p)
	assert.equal(live.redactQuery("Demo Logistics growth").text, "Demo Logistics growth")
	p = profile()
	assert.ok(!/demo logistics/i.test(live.redactQuery("Demo Logistics growth rate in Serbia").text))
})
