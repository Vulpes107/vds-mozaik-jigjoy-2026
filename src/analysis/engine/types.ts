// Local shapes for contract objects used by the analysis engine. They mirror contracts/*.schema.json;
// every object leaving this package is validated against the real schemas (see ../contracts.ts).

export type Case = "low" | "base" | "high"
export type ScenarioKind = "do_nothing" | "optimise" | "expand" | "pivot" | "exit" | "build" | "buy" | "partner"

export interface Assumption {
	id: string
	run_id?: string
	text: string
	unit: string
	low: number
	base: number
	high: number
	user_override?: number | null
	basis_finding_ids?: string[]
	origin?: "research" | "user" | "default" | "reference"
	confidence?: number
	sensitivity_rank?: number
	[extra: string]: unknown
}

/** Code-side description of a scenario. The model supplies this; the engine computes every number. */
export interface ScenarioSpec {
	/** `sc_<alnum>`; low/high cases get the suffixes `Low` / `High`. */
	id: string
	name: string
	kind: Exclude<ScenarioKind, "build" | "buy" | "partner">
	currency: string
	/** Horizon in years, 1..10. */
	years: number
	/** Annual discount rate, 0..1. */
	discount_rate: number
	/** Contingency on capex, percent 0..100 (plan recommends 15-25). */
	contingency_pct: number
	/** Cash available before month 0 (from the company profile). */
	opening_cash: number
	/** Formula for revenue in year `year` (1-based). May use assumption ids and `year`. */
	revenue: string
	/** Formula for operating cost in year `year`. */
	opex: string
	/** Formula for total capex when not staged. Ignored if `tranches` is present. */
	capex?: string
	tranches?: { amount: string; month: number; kill_criteria: string[] }[]
	probability?: number
	notes?: string
}

export interface ScenarioMetrics {
	npv: number
	irr: number | null
	payback_months: number | null
	break_even_month: number | null
	min_cash_balance: number
	runway_breached: boolean
}

export interface Scenario {
	schema_version: "1.0"
	id: string
	run_id: string
	project_id?: string
	name: string
	kind: ScenarioKind
	case: Case
	currency: string
	capex: number
	tranches?: { amount: number; month: number; kill_criteria: string[] }[]
	revenue_by_year: number[]
	opex_by_year: number[]
	contingency_pct: number
	discount_rate: number
	metrics: ScenarioMetrics
	probability?: number
	assumption_ids: string[]
	notes?: string
}

export interface Risk {
	id: string
	title: string
	category: string
	likelihood: number
	severity: number
	mitigation: string
	finding_ids: string[]
}
