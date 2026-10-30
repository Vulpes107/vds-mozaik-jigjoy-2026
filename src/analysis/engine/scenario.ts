// Turns a ScenarioSpec + the assumption registry into a contract-shaped Scenario. Deterministic: same inputs -> same output.
import { compile, compileValue, type Compiled, type Vars } from "./expr.ts"
import { breakEvenMonth, cumulative, irrAnnual, npvMonthly, paybackMonths, round } from "./finance.ts"
import type { Assumption, Case, Scenario, ScenarioMetrics, ScenarioSpec } from "./types.ts"

const ID_RE = /^[a-z]{1,4}_[A-Za-z0-9]+$/
const RESERVED = new Set(["year"])

export interface CompiledSpec {
	spec: ScenarioSpec
	revenue: Compiled
	opex: Compiled
	capex: Compiled | null
	tranches: { amount: Compiled; month: number; kill_criteria: string[] }[]
	/** Assumption ids referenced anywhere in the spec. */
	ids: string[]
}

export function compileSpec(spec: ScenarioSpec): CompiledSpec {
	if (!/^sc_[A-Za-z0-9]+$/.test(spec.id)) throw new Error(`Scenario id "${spec.id}" must look like sc_<letters/digits>`)
	if (!Number.isInteger(spec.years) || spec.years < 1 || spec.years > 10) throw new Error("years must be an integer 1..10")
	if (!(spec.discount_rate >= 0 && spec.discount_rate <= 1)) throw new Error("discount_rate must be between 0 and 1")
	if (!(spec.contingency_pct >= 0 && spec.contingency_pct <= 100)) throw new Error("contingency_pct must be between 0 and 100")
	if (!/^[A-Z]{3}$/.test(spec.currency)) throw new Error("currency must be a 3-letter code such as EUR")
	if (!Number.isFinite(spec.opening_cash)) throw new Error("opening_cash must be a number")
	const tranches = (spec.tranches ?? []).map((t) => {
		if (!Number.isInteger(t.month) || t.month < 0 || t.month >= spec.years * 12) {
			throw new Error(`tranche month ${t.month} is outside the ${spec.years * 12}-month horizon`)
		}
		return { amount: compileValue(t.amount), month: t.month, kill_criteria: t.kill_criteria ?? [] }
	})
	const revenue = compile(spec.revenue)
	const opex = compile(spec.opex)
	const capex = spec.capex !== undefined ? compile(spec.capex) : null
	const ids = new Set<string>()
	for (const c of [revenue, opex, capex, ...tranches.map((t) => t.amount)]) {
		c?.identifiers.forEach((i) => !RESERVED.has(i) && ids.add(i))
	}
	for (const i of ids) if (!ID_RE.test(i)) throw new Error(`"${i}" is not an assumption id (expected e.g. as_001)`)
	if (ids.size === 0) {
		throw new Error("A scenario must reference at least one assumption id; every number needs an assumption")
	}
	return { spec, revenue, opex, capex, tranches, ids: [...ids].sort() }
}

export function indexAssumptions(assumptions: readonly Assumption[]): Map<string, Assumption> {
	return new Map(assumptions.map((a) => [a.id, a]))
}

export const isPinned = (a: Assumption): boolean => a.user_override !== undefined && a.user_override !== null

/** Value for a given pick; a dashboard override always wins and is the same in every case. */
export function pick(a: Assumption, which: Case): number {
	return isPinned(a) ? (a.user_override as number) : a[which]
}

function need(byId: Map<string, Assumption>, id: string): Assumption {
	const a = byId.get(id)
	if (!a) {
		const known = [...byId.keys()].join(", ") || "(none)"
		throw new Error(`Assumption "${id}" does not exist. Known assumptions: ${known}`)
	}
	return a
}

export function valuesAt(ids: readonly string[], byId: Map<string, Assumption>, which: Case): Record<string, number> {
	const out: Record<string, number> = {}
	for (const id of ids) out[id] = pick(need(byId, id), which)
	return out
}

export interface Flows {
	revenue: number[]
	opex: number[]
	capexTotal: number
	tranches: { amount: number; month: number; kill_criteria: string[] }[]
	monthly: number[]
	operating: number[]
	totalInvestment: number
}

export function computeFlows(cs: CompiledSpec, vals: Vars): Flows {
	const { spec } = cs
	const revenue: number[] = []
	const opex: number[] = []
	for (let year = 1; year <= spec.years; year++) {
		revenue.push(cs.revenue.evaluate({ ...vals, year }))
		opex.push(cs.opex.evaluate({ ...vals, year }))
	}
	const tranches = cs.tranches.map((t) => ({ amount: t.amount.evaluate(vals), month: t.month, kill_criteria: t.kill_criteria }))
	for (const t of tranches) if (t.amount < 0) throw new Error("tranche amounts cannot be negative")
	const capexTotal = tranches.length ? tranches.reduce((s, t) => s + t.amount, 0) : cs.capex ? cs.capex.evaluate(vals) : 0
	if (capexTotal < 0) throw new Error("capex cannot be negative")

	const months = spec.years * 12
	const factor = 1 + spec.contingency_pct / 100
	const outflow = new Array<number>(months).fill(0)
	if (tranches.length) for (const t of tranches) outflow[t.month] = (outflow[t.month] as number) + t.amount * factor
	else outflow[0] = capexTotal * factor
	const operating: number[] = []
	const monthly: number[] = []
	for (let m = 0; m < months; m++) {
		const y = Math.floor(m / 12)
		const op = ((revenue[y] as number) - (opex[y] as number)) / 12
		operating.push(op)
		monthly.push(op - (outflow[m] as number))
	}
	return { revenue, opex, capexTotal, tranches, monthly, operating, totalInvestment: capexTotal * factor }
}

export function metricsFor(spec: ScenarioSpec, f: Flows): ScenarioMetrics {
	const cum = cumulative(f.monthly)
	const minCash = spec.opening_cash + Math.min(0, ...cum)
	const irr = irrAnnual(f.monthly)
	return {
		npv: round(npvMonthly(spec.discount_rate, f.monthly)),
		irr: irr === null ? null : round(irr, 4),
		payback_months: paybackMonths(f.monthly, f.totalInvestment),
		break_even_month: breakEvenMonth(f.operating),
		min_cash_balance: round(minCash),
		runway_breached: minCash < 0,
	}
}

/** NPV only; the hot path for sensitivity and break-even searches. */
export function npvOf(cs: CompiledSpec, vals: Vars): number {
	return npvMonthly(cs.spec.discount_rate, computeFlows(cs, vals).monthly)
}

export interface Bounds {
	pessimistic: number
	optimistic: number
	npvAtLow: number
	npvAtHigh: number
}

/**
 * For each referenced assumption: which of low/high hurts the outcome (lower NPV) and which helps,
 * holding every other assumption at base. This makes "low case" mean "adverse" even for cost drivers.
 */
export function boundsFor(cs: CompiledSpec, byId: Map<string, Assumption>): Map<string, Bounds> {
	const base = valuesAt(cs.ids, byId, "base")
	const out = new Map<string, Bounds>()
	for (const id of cs.ids) {
		const a = need(byId, id)
		if (isPinned(a)) {
			const v = pick(a, "base")
			const n = npvOf(cs, base)
			out.set(id, { pessimistic: v, optimistic: v, npvAtLow: n, npvAtHigh: n })
			continue
		}
		const npvAtLow = npvOf(cs, { ...base, [id]: a.low })
		const npvAtHigh = npvOf(cs, { ...base, [id]: a.high })
		const lowIsWorse = npvAtLow <= npvAtHigh
		out.set(id, {
			pessimistic: lowIsWorse ? a.low : a.high,
			optimistic: lowIsWorse ? a.high : a.low,
			npvAtLow,
			npvAtHigh,
		})
	}
	return out
}

export interface ComputeOptions {
	runId: string
	projectId?: string
	case?: Case
}

export function computeScenario(spec: ScenarioSpec, assumptions: readonly Assumption[], opts: ComputeOptions): Scenario {
	const cs = compileSpec(spec)
	return computeCompiled(cs, indexAssumptions(assumptions), opts)
}

export function computeCompiled(cs: CompiledSpec, byId: Map<string, Assumption>, opts: ComputeOptions): Scenario {
	const which: Case = opts.case ?? "base"
	let vals: Record<string, number>
	if (which === "base") vals = valuesAt(cs.ids, byId, "base")
	else {
		const bounds = boundsFor(cs, byId)
		vals = {}
		for (const id of cs.ids) {
			const b = bounds.get(id) as Bounds
			vals[id] = which === "low" ? b.pessimistic : b.optimistic
		}
	}
	const f = computeFlows(cs, vals)
	const { spec } = cs
	const suffix = which === "base" ? "" : which === "low" ? "Low" : "High"
	const scenario: Scenario = {
		schema_version: "1.0",
		id: spec.id + suffix,
		run_id: opts.runId,
		name: spec.name,
		kind: spec.kind,
		case: which,
		currency: spec.currency,
		capex: round(f.capexTotal),
		revenue_by_year: f.revenue.map((x) => round(x)),
		opex_by_year: f.opex.map((x) => round(x)),
		contingency_pct: spec.contingency_pct,
		discount_rate: spec.discount_rate,
		metrics: metricsFor(spec, f),
		assumption_ids: cs.ids,
	}
	if (opts.projectId) scenario.project_id = opts.projectId
	if (cs.tranches.length) scenario.tranches = f.tranches.map((t) => ({ ...t, amount: round(t.amount) }))
	if (spec.probability !== undefined) scenario.probability = spec.probability
	if (spec.notes) scenario.notes = spec.notes
	return scenario
}
