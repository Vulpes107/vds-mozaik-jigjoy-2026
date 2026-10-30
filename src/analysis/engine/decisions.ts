// Continue-vs-change scoring and investment sizing. Heuristic ranking of the options we modelled, NOT probabilities.
import { round } from "./finance.ts"
import type { Scenario } from "./types.ts"

export type Option = "continue" | "optimise" | "expand" | "pivot" | "exit"
export type Appetite = "low" | "medium" | "high"
export const OPTIONS: readonly Option[] = ["continue", "optimise", "expand", "pivot", "exit"]

export const kindToOption = (kind: Scenario["kind"]): Option | null =>
	kind === "do_nothing" ? "continue" : (OPTIONS as readonly string[]).includes(kind) ? (kind as Option) : null

/** Weights for value (base NPV), downside (adverse-case NPV), liquidity (cash never negative), evidence confidence. */
export const WEIGHTS: Record<Appetite, { value: number; downside: number; liquidity: number; confidence: number }> = {
	low: { value: 0.3, downside: 0.35, liquidity: 0.25, confidence: 0.1 },
	medium: { value: 0.45, downside: 0.2, liquidity: 0.2, confidence: 0.15 },
	high: { value: 0.6, downside: 0.15, liquidity: 0.1, confidence: 0.15 },
}

export interface OptionInput {
	option: Option
	base: Scenario
	/** Adverse-case scenario for the same option, when computed. */
	low?: Scenario
}

export interface OptionScore {
	option: Option
	scenario_id: string
	score: number
	components: { value: number; downside: number; liquidity: number; confidence: number }
}

export interface Decision {
	verdict: Option
	scores: Partial<Record<Option, number>>
	ranked: OptionScore[]
	rationale: string
}

function normalise(values: number[]): number[] {
	const min = Math.min(...values)
	const max = Math.max(...values)
	return values.map((v) => (max === min ? 0.5 : (v - min) / (max - min)))
}

export function scoreOptions(inputs: readonly OptionInput[], appetite: Appetite, confidence: number): Decision {
	if (!inputs.some((i) => i.option === "continue")) throw new Error("A do_nothing scenario is required as the baseline")
	const w = WEIGHTS[appetite]
	const value = normalise(inputs.map((i) => i.base.metrics.npv))
	const downside = normalise(inputs.map((i) => (i.low ?? i.base).metrics.npv))
	const ranked: OptionScore[] = inputs.map((i, k) => {
		const liquidity = (i.low ?? i.base).metrics.runway_breached || i.base.metrics.runway_breached ? 0 : 1
		const comp = { value: value[k] as number, downside: downside[k] as number, liquidity, confidence }
		const score = w.value * comp.value + w.downside * comp.downside + w.liquidity * liquidity + w.confidence * confidence
		return { option: i.option, scenario_id: i.base.id, score: round(score, 3), components: comp }
	})
	// Highest score wins; ties prefer the more reversible option (lower index in OPTIONS).
	ranked.sort((a, b) => b.score - a.score || OPTIONS.indexOf(a.option) - OPTIONS.indexOf(b.option))
	const best = ranked[0] as OptionScore
	const second = ranked[1]
	const scores: Partial<Record<Option, number>> = {}
	for (const r of ranked) scores[r.option] = r.score
	const top = (Object.entries(best.components) as [string, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "value"
	const rationale =
		`"${best.option}" ranks first (${best.score})` +
		(second ? ` ahead of "${second.option}" (${second.score})` : "") +
		`, strongest on ${top}. Weights reflect ${appetite} risk appetite; scores rank the modelled options and are not probabilities.`
	return { verdict: best.option, scores, ranked, rationale }
}

export interface Investment {
	currency: string
	low: number
	base: number
	high: number
	staged: boolean
	rationale: string
}

/** Capex incl. contingency across the adverse/base/favourable cases; low <= base <= high. */
export function sizeInvestment(base: Scenario, low?: Scenario, high?: Scenario): Investment {
	const amt = (s: Scenario) => round(s.capex * (1 + s.contingency_pct / 100))
	const values = [amt(base), amt(low ?? base), amt(high ?? base)]
	const lo = Math.min(...values)
	const hi = Math.max(...values)
	const b = amt(base)
	const staged = (base.tranches?.length ?? 0) > 1
	return {
		currency: base.currency,
		low: lo,
		base: b,
		high: hi,
		staged,
		rationale:
			b === 0
				? "No capital is required for this option."
				: `Capex including ${base.contingency_pct}% contingency across modelled cases` +
					(staged ? `, released in ${base.tranches!.length} tranches with kill criteria.` : ". Consider staging it with gates."),
	}
}
