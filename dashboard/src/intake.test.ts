import { test } from "node:test"
import assert from "node:assert/strict"
import sample from "../../mocks/company_profile.sample.json"
import { check, clean, recommend, RECOMMENDED, sizeSlots, type Intake } from "./intake.ts"
import type { CompanyProfile } from "./types/contracts.ts"

const base = (): Intake => ({ profile: structuredClone(sample) as CompanyProfile, auto_approve: false })

test("the golden profile with recommended settings passes without errors", () => {
	const i = base()
	i.profile.run_budget = recommend(i.profile).run_budget
	assert.deepEqual(check(i), { errors: [], warnings: [] })
})
test("missing required fields, bad numbers and an unaffordable run are errors; soft problems are warnings", () => {
	const i = base()
	i.profile.name = " "
	i.profile.products = [{ name: "x", description: "" }]
	i.profile.headcount = 2.5
	i.profile.currency = "eur"
	i.profile.run_budget = { usd: 0.1, seconds: 120 }
	i.profile.financials = { cash_on_hand: 1000, investable_budget: 5000 }
	const r = check(i)
	assert.equal(r.errors.length, 6, r.errors.join("\n"))
	assert.ok(r.warnings.some((w) => w.startsWith("Investable budget")))
})
test("no products blocks the start", () => {
	const i = base()
	i.profile.products = [{ name: "", description: "" }] as CompanyProfile["products"]
	assert.ok(check(i).errors.some((e) => e.includes("At least one product")))
})
test("slots are sized from money over time: never below scout+collector+analyst, verifier next, then parallelism, capped", () => {
	assert.deepEqual(sizeSlots({ usd: 1, seconds: 3600 }), { scout: 1, collector: 1, analyst: 1, verifier: 0 })
	assert.deepEqual(sizeSlots({ usd: 2, seconds: 1800 }), { scout: 1, collector: 1, analyst: 1, verifier: 0 })
	assert.deepEqual(sizeSlots({ usd: 5, seconds: 1800 }), { scout: 1, collector: 1, analyst: 1, verifier: 1 })
	assert.deepEqual(sizeSlots({ usd: 2.4, seconds: 600 }), { scout: 2, collector: 1, analyst: 2, verifier: 1 })
	assert.deepEqual(sizeSlots({ usd: 50, seconds: 600 }), { scout: 2, collector: 2, analyst: 2, verifier: 2 })
	assert.deepEqual(sizeSlots(), sizeSlots(RECOMMENDED))
	assert.equal(Object.values(clean(base()).slots).reduce((a, b) => a + b), 3, "the golden fixture carries no run_budget: defaults apply")
})
test("recommendations scale with products and react to runway", () => {
	const one = recommend(base().profile)
	assert.equal(one.run_budget.usd, 4)
	assert.equal(one.runway_months, null) // cash-positive
	assert.equal(one.investable_budget, 150000)
	const p = base().profile
	p.products = [...p.products, { name: "b", description: "b" }, { name: "c", description: "c" }]
	p.financials = { monthly_burn: 50000, annual_revenue: 0, cash_on_hand: 200000 }
	const three = recommend(p)
	assert.equal(three.run_budget.usd, 6)
	assert.equal(three.run_budget.seconds, 3000)
	assert.equal(three.runway_months, 4)
	assert.equal(three.risk_appetite, "low")
	assert.ok(check({ profile: p, auto_approve: false }).warnings.some((w) => w.includes("Runway")))
})
test("clean drops blanks the schema would reject and keeps the schema version", () => {
	const i = base()
	i.profile.currency = ""
	i.profile.countries = ["RS", "", " HR "]
	i.profile.financials = { annual_revenue: undefined }
	i.profile.products = [...i.profile.products, { name: " ", description: "" }]
	const c = clean(i).profile
	assert.equal(c.schema_version, "1.0")
	assert.equal("currency" in c, false)
	assert.equal("financials" in c, false)
	assert.deepEqual(c.countries, ["RS", "HR"])
	assert.equal(c.products.length, 1)
})
