// Build vs buy vs partner: total cost of ownership over a horizon, plus the volume at which the verdict flips.
import { compileValue } from "./expr.ts"
import { round } from "./finance.ts"
import { indexAssumptions, valuesAt } from "./scenario.ts"
import type { Assumption } from "./types.ts"

type F = string | number // literal or formula over assumption ids

export interface TcoSpec {
	capability: string
	/** 1..10 */
	horizon_years: number
	/** Units per month the capability must handle (invoices, users, routes...). */
	volume_per_month: F
	/** Opportunity cost per month of delay before the capability is live. */
	delay_cost_per_month?: F
	build: {
		dev_cost?: F
		annual_maintenance?: F
		/** Cost per unit (internal infra, support). */
		variable_cost_per_unit?: F
		time_to_market_months?: F
		/** Cost to retire or migrate away. */
		exit_cost?: F
	}
	buy: SideSpec
	partner?: SideSpec
}

interface SideSpec {
	integration_cost?: F
	annual_license?: F
	variable_fee_per_unit?: F
	time_to_market_months?: F
	/** Lock-in: cost to switch vendor later. */
	exit_cost?: F
}

export interface TcoOption {
	fixed: number
	variable: number
	total: number
}

export interface TcoResult {
	capability: string
	horizon_years: number
	volume_per_month: number
	build: TcoOption
	buy: TcoOption
	partner?: TcoOption
	verdict: "build" | "buy" | "partner"
	flip_point: string
	/** Volume (units/month) at which build and buy cost the same, if it exists and is positive. */
	flip_volume: number | null
	assumption_ids: string[]
}

export function computeTco(spec: TcoSpec, assumptions: readonly Assumption[]): TcoResult {
	if (!Number.isInteger(spec.horizon_years) || spec.horizon_years < 1 || spec.horizon_years > 10) {
		throw new Error("horizon_years must be an integer 1..10")
	}
	const fields: Record<string, F | undefined> = {
		volume: spec.volume_per_month,
		delay: spec.delay_cost_per_month,
		b_dev: spec.build.dev_cost,
		b_maint: spec.build.annual_maintenance,
		b_var: spec.build.variable_cost_per_unit,
		b_ttm: spec.build.time_to_market_months,
		b_exit: spec.build.exit_cost,
		u_int: spec.buy.integration_cost,
		u_lic: spec.buy.annual_license,
		u_var: spec.buy.variable_fee_per_unit,
		u_ttm: spec.buy.time_to_market_months,
		u_exit: spec.buy.exit_cost,
		p_int: spec.partner?.integration_cost,
		p_lic: spec.partner?.annual_license,
		p_var: spec.partner?.variable_fee_per_unit,
		p_ttm: spec.partner?.time_to_market_months,
		p_exit: spec.partner?.exit_cost,
	}
	const compiled = Object.fromEntries(
		Object.entries(fields)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => [k, compileValue(v as F)]),
	)
	const ids = [...new Set(Object.values(compiled).flatMap((c) => [...c.identifiers]))].sort()
	const byId = indexAssumptions(assumptions)
	const vals = valuesAt(ids, byId, "base")
	const g = (k: string): number => {
		const v = compiled[k]?.evaluate(vals) ?? 0
		if (v < 0) throw new Error(`${k} cannot be negative`)
		return v
	}
	const Y = spec.horizon_years
	const volume = g("volume")
	const delay = g("delay")

	const side = (fixed: number, perUnitPerMonth: number): TcoOption => {
		const variable = perUnitPerMonth * 12 * Y * volume
		return { fixed: round(fixed), variable: round(variable), total: round(fixed + variable) }
	}
	const bFixed = g("b_dev") + g("b_maint") * Y + g("b_ttm") * delay + g("b_exit")
	const uFixed = g("u_int") + g("u_lic") * Y + g("u_ttm") * delay + g("u_exit")
	const build = side(bFixed, g("b_var"))
	const buy = side(uFixed, g("u_var"))
	const partner = spec.partner ? side(g("p_int") + g("p_lic") * Y + g("p_ttm") * delay + g("p_exit"), g("p_var")) : undefined

	// Verdict: lowest total; exact ties prefer buy, then partner, then build (faster, more reversible).
	const entries: ["buy" | "partner" | "build", TcoOption][] = [["buy", buy]]
	if (partner) entries.push(["partner", partner])
	entries.push(["build", build])
	const verdict = entries.reduce((best, cur) => (cur[1].total < best[1].total ? cur : best))[0]

	// Flip: build - buy = (fixedB - fixedU) + (slopeB - slopeU) * v, with slope = per-unit-per-month * 12 * Y.
	const dFixed = bFixed - uFixed
	const dSlope = (g("b_var") - g("u_var")) * 12 * Y
	let flipVolume: number | null = null
	let flip: string
	if (dSlope === 0) {
		flip = dFixed === 0 ? "Build and buy cost the same at every volume." : `${dFixed > 0 ? "Buy" : "Build"} is cheaper at every volume (no volume-driven flip).`
	} else {
		const v = -dFixed / dSlope
		if (v <= 0) {
			const cheaper = dFixed + dSlope * Math.max(volume, 1) < 0 ? "Build" : "Buy"
			flip = `${cheaper} is cheaper at every positive volume (no volume-driven flip).`
		} else {
			flipVolume = round(v)
			const aboveWinner = dSlope < 0 ? "Build" : "Buy"
			const belowWinner = aboveWinner === "Build" ? "Buy" : "Build"
			flip = `${aboveWinner} wins above ~${Math.round(v).toLocaleString("en-US")} units/month; ${belowWinner} wins below.`
		}
	}
	if (verdict === "partner") flip += " (Partner is cheapest overall; flip shown for build vs buy.)"

	const result: TcoResult = {
		capability: spec.capability,
		horizon_years: Y,
		volume_per_month: volume,
		build,
		buy,
		verdict,
		flip_point: flip,
		flip_volume: flipVolume,
		assumption_ids: ids,
	}
	if (partner) result.partner = partner
	return result
}
