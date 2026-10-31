import { test } from "node:test"
import assert from "node:assert/strict"
import { compile } from "./expr.ts"
import { breakEvenMonth, irrAnnual, npvMonthly, paybackMonths } from "./finance.ts"
import { compileSpec, computeScenario } from "./scenario.ts"
import { breakEvenValue, rankAssumptions, tornado } from "./sensitivity.ts"
import { cohort, ramp } from "./expr.ts"
import { computeTco } from "./tco.ts"
import type { Assumption, ScenarioSpec } from "./types.ts"

const near = (a: number | null, b: number, eps = 1e-6) => {
	assert.ok(a !== null && Math.abs(a - b) <= eps, `expected ${a} ~ ${b}`)
}

const A = (id: string, text: string, low: number, base: number, high: number, extra: Partial<Assumption> = {}): Assumption => ({
	id,
	text,
	unit: "x",
	low,
	base,
	high,
	confidence: 0.7,
	origin: "research",
	basis_finding_ids: ["f_001"],
	...extra,
})

const assumptions: Assumption[] = [
	A("as_001", "Price per unit", 80, 100, 120),
	A("as_002", "Units per year", 900, 1000, 1100),
	A("as_003", "Operating cost per year", 40000, 50000, 60000),
]

const expandSpec: ScenarioSpec = {
	id: "sc_expand",
	name: "Expand",
	kind: "expand",
	currency: "EUR",
	years: 2,
	discount_rate: 0,
	contingency_pct: 0,
	opening_cash: 10000,
	revenue: "as_001 * as_002",
	opex: "as_003",
	capex: "24000",
}

// ---- expr ----
test("expr: precedence, unary minus, power, functions", () => {
	assert.equal(compile("2 + 3 * 4").evaluate({}), 14)
	assert.equal(compile("-2 ^ 2").evaluate({}), -4)
	assert.equal(compile("2 ^ 3 ^ 2").evaluate({}), 512)
	assert.equal(compile("max(1, min(5, 3)) + abs(-2)").evaluate({}), 5)
	assert.equal(compile("as_001 * (1 + g) ^ (year - 1)").evaluate({ as_001: 100, g: 0.1, year: 3 }), 121.00000000000001)
	assert.deepEqual([...compile("as_001 * year + max(as_002, 1)").identifiers].sort(), ["as_001", "as_002", "year"])
})

test("expr: rejects unsafe or malformed input", () => {
	assert.throws(() => compile("process.exit(1)"), /Unknown function|Unexpected/)
	assert.throws(() => compile("1 +"), /ended unexpectedly/)
	assert.throws(() => compile("1 $ 2"), /Unexpected character/)
	assert.throws(() => compile("(1 + 2"), /ended unexpectedly/)
	assert.throws(() => compile("x").evaluate({}), /Unknown variable/)
	assert.throws(() => compile("1 / 0").evaluate({}), /Division by zero/)
})

// ---- finance golden numbers (hand-checked) ----
test("finance: NPV, IRR, payback, break-even golden values", () => {
	// -1000 now, +1100 in month 12, 10% annual: NPV = 0, IRR = 10%.
	const flows = new Array<number>(13).fill(0)
	flows[0] = -1000
	flows[12] = 1100
	near(npvMonthly(0.1, flows), 0, 1e-9)
	near(irrAnnual(flows), 0.1, 1e-6)
	assert.equal(irrAnnual([100, 100]), null) // no sign change
	assert.equal(paybackMonths([-100, 40, 40, 40], 100), 4)
	assert.equal(paybackMonths([-100, 10, 10, 10], 100), null)
	assert.equal(paybackMonths([10, 10], 0), null)
	assert.equal(breakEvenMonth([-1, -1, 2, 2]), 2)
	assert.equal(breakEvenMonth([1, -1, 2]), 2)
	assert.equal(breakEvenMonth([1, 1, -1]), null)
})

// ---- scenario ----
test("scenario: base case metrics match hand calculation", () => {
	const s = computeScenario(expandSpec, assumptions, { runId: "r_t" })
	// revenue 100,000/yr, opex 50,000/yr, capex 24,000, rate 0 -> NPV = 2*50,000 - 24,000
	assert.equal(s.metrics.npv, 76000)
	assert.equal(s.capex, 24000)
	assert.deepEqual(s.revenue_by_year, [100000, 100000])
	assert.equal(s.metrics.payback_months, 6) // 4166.67*k - 24000 >= 0 first at k = 6
	assert.equal(s.metrics.break_even_month, 0)
	assert.equal(s.metrics.min_cash_balance, -9833.33) // 10,000 + (4166.67 - 24,000)
	assert.equal(s.metrics.runway_breached, true)
	assert.deepEqual(s.assumption_ids, ["as_001", "as_002", "as_003"])
	assert.equal(s.id, "sc_expand")
})

test("scenario: low/high cases use the adverse/favourable bound, even for cost drivers", () => {
	const low = computeScenario(expandSpec, assumptions, { runId: "r_t", case: "low" })
	const high = computeScenario(expandSpec, assumptions, { runId: "r_t", case: "high" })
	// Adverse: price 80, units 900, opex 60,000 -> revenue 72,000, op 12,000/yr -> NPV 24,000 - 24,000 = 0
	assert.equal(low.metrics.npv, 0)
	assert.deepEqual(low.opex_by_year, [60000, 60000])
	// Favourable: price 120, units 1100, opex 40,000 -> revenue 132,000, op 92,000/yr -> 184,000 - 24,000
	assert.equal(high.metrics.npv, 160000)
	assert.equal(low.id, "sc_expandLow")
	assert.equal(high.id, "sc_expandHigh")
	assert.equal(low.case, "low")
})

test("scenario: contingency, tranches and year-dependent formulas", () => {
	const spec: ScenarioSpec = {
		...expandSpec,
		id: "sc_staged",
		contingency_pct: 20,
		capex: undefined,
		tranches: [
			{ amount: "10000", month: 0, kill_criteria: ["gate A"] },
			{ amount: "14000", month: 6, kill_criteria: ["gate B"] },
		],
		revenue: "as_001 * as_002 * (1 + 0.1) ^ (year - 1)",
	}
	const s = computeScenario(spec, assumptions, { runId: "r_t" })
	assert.equal(s.capex, 24000) // stored pre-contingency
	assert.equal(s.tranches?.length, 2)
	assert.deepEqual(s.revenue_by_year, [100000, 110000])
	// NPV(rate 0) = (100,000-50,000) + (110,000-50,000) - 24,000*1.2
	assert.equal(s.metrics.npv, 110000 - 28800)
})

test("scenario: every number needs an assumption; unknown ids fail with a helpful error", () => {
	assert.throws(() => computeScenario({ ...expandSpec, revenue: "100000", opex: "50000" }, assumptions, { runId: "r_t" }), /at least one assumption/)
	assert.throws(() => computeScenario({ ...expandSpec, revenue: "as_999 * 2" }, assumptions, { runId: "r_t" }), /as_999.*Known assumptions: as_001/)
	assert.throws(() => compileSpec({ ...expandSpec, years: 11 }), /years/)
	assert.throws(() => compileSpec({ ...expandSpec, tranches: [{ amount: "1", month: 99, kill_criteria: [] }] }), /horizon/)
})

test("scenario: user_override wins in every case", () => {
	const pinned = assumptions.map((a) => (a.id === "as_001" ? { ...a, user_override: 90 } : a))
	for (const c of ["low", "base", "high"] as const) {
		const s = computeScenario(expandSpec, pinned, { runId: "r_t", case: c })
		const unitsOpex = c === "low" ? [900, 60000] : c === "base" ? [1000, 50000] : [1100, 40000]
		assert.equal(s.revenue_by_year[0], 90 * (unitsOpex[0] as number))
	}
})

test("scenario: reproducible (same inputs -> identical output)", () => {
	const a = computeScenario(expandSpec, assumptions, { runId: "r_t" })
	const b = computeScenario(expandSpec, structuredClone(assumptions), { runId: "r_t" })
	assert.deepEqual(a, b)
})

test("scenario: undefined IRR and unrecovered investment are null, not NaN", () => {
	const spec: ScenarioSpec = { ...expandSpec, id: "sc_dud", revenue: "as_001", opex: "as_003", capex: "500000" }
	const s = computeScenario(spec, assumptions, { runId: "r_t" })
	assert.equal(s.metrics.payback_months, null)
	assert.ok(s.metrics.npv < 0)
	assert.ok(s.metrics.irr === null || Number.isFinite(s.metrics.irr))
})

// ---- sensitivity ----
test("sensitivity: tornado ordered by swing, ranks assigned", () => {
	const rows = tornado(expandSpec, assumptions)
	// swings (NPV, others at base): price 2*20,000*2=80,000; opex 2*20,000=40,000; units 2*10,000... = 40,000? price*units
	assert.equal(rows[0]?.assumption_id, "as_001")
	assert.equal(rows[0]?.swing, 80000)
	assert.equal(rows.map((r) => r.rank).join(","), "1,2,3")
	assert.ok(rows.every((r, i) => i === 0 || (rows[i - 1] as { swing: number }).swing >= r.swing))
	// cost driver: pessimistic value is the HIGH one
	const cost = rows.find((r) => r.assumption_id === "as_003")!
	assert.equal(cost.pessimistic, 60000)
	assert.equal(cost.optimistic, 40000)
	assert.equal(tornado(expandSpec, assumptions, 2).length, 2)
})

test("sensitivity: pinned assumptions have zero swing; ranks aggregate across specs", () => {
	const pinned = assumptions.map((a) => (a.id === "as_001" ? { ...a, user_override: 100 } : a))
	const rows = tornado(expandSpec, pinned)
	assert.equal(rows.find((r) => r.assumption_id === "as_001")?.swing, 0)
	const ranks = rankAssumptions([expandSpec], assumptions)
	assert.equal(ranks.get("as_001"), 1)
})

test("expr: cohort and ramp wire churn and time to market into revenue", () => {
	// 100 adds/month, no churn, no build time: month m has 100m active; year 1 = 100 * (1+...+12) = 7,800 subscriber-months.
	near(cohort(100, 0, 1), 7800, 1e-9)
	// 20 % monthly churn: steady state 500 subscribers; year 3 is close to 12 * 500.
	assert.ok(cohort(100, 0.2, 3) > 5900 && cohort(100, 0.2, 3) < 6000, String(cohort(100, 0.2, 3)))
	// A 6-month build delays the cohort by 6 months: year 1 only has months 1..6 of growth.
	near(cohort(100, 0, 1, 6), 100 * (1 + 2 + 3 + 4 + 5 + 6), 1e-9)
	near(ramp(6, 1), 0.5, 1e-12)
	near(ramp(6, 2), 1, 1e-12)
	near(ramp(18, 1), 0, 1e-12)
	near(compile("cohort(as_001, as_002 / 100, year, 6) * 2").evaluate({ as_001: 100, as_002: 0, year: 1 }), 4200, 1e-9)
	assert.throws(() => compile("cohort(100, 25, 1)").evaluate({}), /fraction 0..1/)
	assert.throws(() => compile("cohort(100, 0.1)"), /takes 3 to 4 arguments/)
})

test("sensitivity: break-even value where plan stops beating baseline", () => {
	const baseline: ScenarioSpec = { ...expandSpec, id: "sc_nothing", name: "Do nothing", kind: "do_nothing", capex: "0", revenue: "as_001 * as_002 * 0.7", opex: "as_003 * 0.7" }
	// units 1000, rate 0, 2 years. expand NPV = 2000*P - 124,000; baseline NPV = 1400*P - 70,000.
	// Equal at P = 54,000 / 600 = 90 (expand wins above it; at base P = 100 it wins by 6,000).
	const v = breakEvenValue(compileSpec(expandSpec), compileSpec(baseline), assumptions, "as_001")
	near(v, 90, 1e-6)
	// Where the plan survives its whole range (baseline too weak to catch it) there is no break-even.
	const weak: ScenarioSpec = { ...baseline, revenue: "as_001 * as_002 * 0.5", opex: "as_003 * 0.5" }
	assert.equal(breakEvenValue(compileSpec(expandSpec), compileSpec(weak), assumptions, "as_001"), null)
	// The other direction: a plan that loses at base (capex 60,000) pays off above price 150 (hand-solved: 2000P - 160,000 = 1400P - 70,000).
	const heavy: ScenarioSpec = { ...expandSpec, capex: "60000" }
	const wide = assumptions.map((a) => (a.id === "as_001" ? { ...a, high: 200 } : a))
	near(breakEvenValue(compileSpec(heavy), compileSpec(baseline), wide, "as_001")!, 150, 1e-6)
	assert.equal(breakEvenValue(compileSpec(heavy), compileSpec(baseline), assumptions, "as_001"), null) // high 120 never gets there
	// At that price the NPVs should match.
	const at = assumptions.map((a) => (a.id === "as_001" ? { ...a, user_override: v } : a))
	const diff =
		computeScenario(expandSpec, at, { runId: "r_t" }).metrics.npv - computeScenario(baseline, at, { runId: "r_t" }).metrics.npv
	assert.ok(Math.abs(diff) < 1, `diff ${diff}`)
})

// ---- tco ----
test("tco: totals, verdict and flip point (hand-checked)", () => {
	const r = computeTco(
		{
			capability: "Billing",
			horizon_years: 3,
			volume_per_month: 1000,
			delay_cost_per_month: 5000,
			build: { dev_cost: 200000, annual_maintenance: 20000, variable_cost_per_unit: 0.5, time_to_market_months: 6 },
			buy: { integration_cost: 10000, annual_license: 30000, variable_fee_per_unit: 2 },
		},
		[],
	)
	assert.equal(r.build.fixed, 290000)
	assert.equal(r.build.total, 308000)
	assert.equal(r.buy.fixed, 100000)
	assert.equal(r.buy.total, 172000)
	assert.equal(r.verdict, "buy")
	near(r.flip_volume, 3518.52, 0.01)
	assert.match(r.flip_point, /Build wins above ~3,519 units\/month/)
})

test("tco: verdict flips at high volume; partner can win; formulas use assumptions", () => {
	const spec = {
		capability: "Routing",
		horizon_years: 3,
		volume_per_month: "as_002 * 10",
		build: { dev_cost: 200000, variable_cost_per_unit: 0.5 },
		buy: { integration_cost: 10000, variable_fee_per_unit: 2 },
	}
	assert.equal(computeTco(spec, assumptions).verdict, "build") // 10,000 units/month >> flip
	const withPartner = computeTco({ ...spec, partner: { integration_cost: 1000, variable_fee_per_unit: 0.1 } }, assumptions)
	assert.equal(withPartner.verdict, "partner")
	assert.deepEqual(withPartner.assumption_ids, ["as_002"])
	assert.throws(() => computeTco({ ...spec, horizon_years: 0 }, assumptions), /horizon_years/)
})
