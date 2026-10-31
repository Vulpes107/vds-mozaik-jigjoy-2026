// Tornado sensitivity and break-even searches over the assumption registry.
import { round } from "./finance.ts"
import {
	boundsFor,
	compileSpec,
	indexAssumptions,
	isPinned,
	npvOf,
	valuesAt,
	type CompiledSpec,
} from "./scenario.ts"
import type { Assumption, ScenarioSpec } from "./types.ts"

export interface TornadoRow {
	assumption_id: string
	text: string
	unit: string
	/** The adverse and favourable values (not necessarily low/high: cost drivers are inverted). */
	pessimistic: number
	optimistic: number
	npv_at_pessimistic: number
	npv_at_optimistic: number
	/** |NPV swing| across the assumption's range, others at base. */
	swing: number
	rank: number
}

export function tornado(spec: ScenarioSpec | CompiledSpec, assumptions: readonly Assumption[], top = 5): TornadoRow[] {
	const cs = "ids" in spec ? spec : compileSpec(spec)
	const byId = indexAssumptions(assumptions)
	const bounds = boundsFor(cs, byId)
	const rows = cs.ids.map((id) => {
		const a = byId.get(id) as Assumption
		const b = bounds.get(id)!
		const lowIsPess = b.pessimistic === a.low && !isPinned(a)
		const npvPess = lowIsPess ? b.npvAtLow : b.npvAtHigh
		const npvOpt = lowIsPess ? b.npvAtHigh : b.npvAtLow
		return {
			assumption_id: id,
			text: a.text,
			unit: a.unit,
			pessimistic: b.pessimistic,
			optimistic: b.optimistic,
			npv_at_pessimistic: round(npvPess),
			npv_at_optimistic: round(npvOpt),
			swing: round(Math.abs(npvOpt - npvPess)),
			rank: 0,
		}
	})
	rows.sort((x, y) => y.swing - x.swing || x.assumption_id.localeCompare(y.assumption_id))
	rows.forEach((r, i) => (r.rank = i + 1))
	return rows.slice(0, top)
}

/** Rank every assumption by its largest NPV swing across all specs (1 = most influential). */
export function rankAssumptions(specs: readonly ScenarioSpec[], assumptions: readonly Assumption[]): Map<string, number> {
	const best = new Map<string, number>()
	for (const spec of specs) {
		for (const row of tornado(spec, assumptions, Number.MAX_SAFE_INTEGER)) {
			best.set(row.assumption_id, Math.max(best.get(row.assumption_id) ?? 0, row.swing))
		}
	}
	const ordered = [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
	return new Map(ordered.map(([id], i) => [id, i + 1]))
}

/**
 * Value of one assumption at which `chosen` and `baseline` swap places in NPV, every other assumption at base.
 * When `chosen` wins at base the search runs toward its adverse bound (where does the plan stop paying off?);
 * when it loses at base it runs toward the favourable bound (what would it take for the plan to pay off?).
 * Null when the ranking holds across the assumption's whole range.
 */
export function breakEvenValue(
	chosen: CompiledSpec,
	baseline: CompiledSpec,
	assumptions: readonly Assumption[],
	assumptionId: string,
): number | null {
	const byId = indexAssumptions(assumptions)
	const a = byId.get(assumptionId)
	if (!a || isPinned(a)) return null
	const ids = [...new Set([...chosen.ids, ...baseline.ids])]
	const base = valuesAt(ids, byId, "base")
	const b = boundsFor(chosen, byId).get(assumptionId)
	if (!b) return null
	const diff = (v: number) => {
		const vals = { ...base, [assumptionId]: v }
		return npvOf(chosen, vals) - npvOf(baseline, vals)
	}
	const d0 = diff(base[assumptionId] as number)
	const wins = d0 > 0
	const far = wins ? b.pessimistic : b.optimistic
	if ((diff(far) > 0) === wins) return null
	let same = base[assumptionId] as number // side that keeps the base ranking
	let flipped = far
	for (let i = 0; i < 60; i++) {
		const mid = (same + flipped) / 2
		if ((diff(mid) > 0) === wins) same = mid
		else flipped = mid
	}
	return (same + flipped) / 2
}
