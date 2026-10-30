// Deterministic red team: tries to break the chosen option and returns the risk register.
// Likelihood/severity are heuristic 0..1 ratings, not statistical probabilities.
import { round } from "./finance.ts"
import type { CompiledSpec } from "./scenario.ts"
import { breakEvenValue, type TornadoRow } from "./sensitivity.ts"
import type { TcoResult } from "./tco.ts"
import type { Assumption, Risk, Scenario } from "./types.ts"

export interface Breakpoint {
	assumption_id: string
	text: string
	unit: string
	/** Value at which the chosen option stops beating doing nothing. */
	value: number
	base: number
	statement: string
}

export interface RedTeamInput {
	chosen: { spec: CompiledSpec; base: Scenario; low?: Scenario }
	baseline: { spec: CompiledSpec; base: Scenario }
	assumptions: readonly Assumption[]
	/** Tornado rows for the chosen spec, most influential first. */
	tornado: readonly TornadoRow[]
	profile?: { financials?: { cash_on_hand?: number; monthly_burn?: number } | undefined; countries?: string[] | undefined } | undefined
	unresolvedTopicIds: readonly string[]
	buildBuy: readonly TcoResult[]
}

export interface RedTeamResult {
	risks: Risk[]
	breakpoints: Breakpoint[]
	/** Present when the plan runs out of cash; the synthesizer must lead with it. */
	liquidityWarning: string | null
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US")
const num = (n: number) => (Math.abs(n) >= 100 ? fmt(n) : String(round(n, 3)))

export function redTeam(input: RedTeamInput): RedTeamResult {
	const { chosen, baseline, assumptions, tornado } = input
	const byId = new Map(assumptions.map((a) => [a.id, a]))
	const basis = (ids: readonly string[]) => [...new Set(ids.flatMap((id) => byId.get(id)?.basis_finding_ids ?? []))]
	const risks: Risk[] = []
	const cur = chosen.base.currency
	const m = chosen.base.metrics
	let liquidityWarning: string | null = null

	// 1. Liquidity: runway vs payback.
	const fin = input.profile?.financials
	const runwayMonths = fin?.cash_on_hand !== undefined && fin.monthly_burn && fin.monthly_burn > 0 ? fin.cash_on_hand / fin.monthly_burn : null
	const paybackLongerThanRunway = runwayMonths !== null && m.payback_months !== null && m.payback_months > runwayMonths
	if (m.runway_breached || paybackLongerThanRunway) {
		const parts = [m.runway_breached ? `cash goes negative (minimum balance ${fmt(m.min_cash_balance)} ${cur})` : null]
		if (paybackLongerThanRunway) parts.push(`payback takes ${m.payback_months} months but runway is about ${round(runwayMonths as number, 1)} months`)
		liquidityWarning = `LIQUIDITY WARNING: under the base case ${parts.filter(Boolean).join(" and ")}. Secure funding or stage the investment before committing capital.`
		risks.push({
			id: "rk_liquidity",
			title: "Cash runway shorter than payback",
			category: "liquidity",
			likelihood: 0.7,
			severity: 0.9,
			mitigation: "Release capital in tranches with kill criteria; arrange a credit line or funding before tranche 2.",
			finding_ids: basis(chosen.base.assumption_ids),
		})
	} else if (chosen.low?.metrics.runway_breached) {
		risks.push({
			id: "rk_liquidity",
			title: "Cash goes negative under adverse assumptions",
			category: "liquidity",
			likelihood: 0.35,
			severity: 0.8,
			mitigation: "Hold a cash buffer for the adverse case and stage the investment.",
			finding_ids: basis(chosen.base.assumption_ids),
		})
	}

	// 2. Break points: which assumption, at what value, makes the chosen option lose to doing nothing.
	const breakpoints: Breakpoint[] = []
	if (chosen.base.kind !== "do_nothing") {
		for (const row of tornado.slice(0, 3)) {
			const v = breakEvenValue(chosen.spec, baseline.spec, assumptions, row.assumption_id)
			if (v === null) continue
			const a = byId.get(row.assumption_id)!
			const base = a.user_override ?? a.base
			const dir = v > base ? "above" : "below"
			breakpoints.push({
				assumption_id: a.id,
				text: a.text,
				unit: a.unit,
				value: round(v, 4),
				base,
				statement: `${a.text} ${dir} ${num(v)} ${a.unit} (base ${num(base)}) makes doing nothing the better option.`,
			})
		}
		if (breakpoints.length) {
			risks.push({
				id: "rk_fragilePlan",
				title: "Recommendation reverses within the plausible range of a key assumption",
				category: "strategy",
				likelihood: 0.3,
				severity: 0.7,
				mitigation: `Validate "${breakpoints[0]!.text}" first (cheap pilot or customer data) before releasing later tranches.`,
				finding_ids: basis(breakpoints.map((b) => b.assumption_id)),
			})
		}
		if (chosen.low && chosen.low.metrics.npv < baseline.base.metrics.npv) {
			risks.push({
				id: "rk_notRobust",
				title: "Under adverse assumptions the chosen option underperforms doing nothing",
				category: "strategy",
				likelihood: 0.4,
				severity: 0.7,
				mitigation: "Define the exit trigger in advance and keep the first tranche small.",
				finding_ids: basis(chosen.base.assumption_ids),
			})
		}
	}

	// 3. Weak evidence under the most influential assumptions.
	const weak = tornado.slice(0, 3).filter((r) => {
		const a = byId.get(r.assumption_id)
		return a && ((a.confidence ?? 0.3) < 0.5 || a.origin === "default")
	})
	if (weak.length) {
		risks.push({
			id: "rk_weakEvidence",
			title: `Key assumptions lack evidence: ${weak.map((w) => w.text).join("; ")}`,
			category: "data",
			likelihood: 0.6,
			severity: 0.6,
			mitigation: "Commission primary research (survey, interviews, pilot data) for these inputs.",
			finding_ids: [],
		})
	}

	// 4. Open research topics.
	if (input.unresolvedTopicIds.length) {
		risks.push({
			id: "rk_evidenceGap",
			title: `${input.unresolvedTopicIds.length} research topic(s) did not finish`,
			category: "data",
			likelihood: 0.5,
			severity: Math.min(0.9, round(0.3 + 0.1 * input.unresolvedTopicIds.length, 2)),
			mitigation: "Re-run or manually research the unresolved topics before final approval.",
			finding_ids: [],
		})
	}

	// 5. Missing company financials.
	if (!fin || fin.cash_on_hand === undefined) {
		risks.push({
			id: "rk_dataGap",
			title: "Company financials not provided; cash and runway figures are illustrative",
			category: "data",
			likelihood: 1,
			severity: 0.5,
			mitigation: "Provide cash on hand, monthly burn and investable budget to sharpen the liquidity analysis.",
			finding_ids: [],
		})
	}

	// 6. Multi-country exposure we do not model.
	if ((input.profile?.countries?.length ?? 0) > 1) {
		risks.push({
			id: "rk_fxRegulatory",
			title: "Multi-country operations: FX and per-jurisdiction regulation are not modelled",
			category: "macro",
			likelihood: 0.4,
			severity: 0.4,
			mitigation: "Add currency and compliance assumptions per country.",
			finding_ids: [],
		})
	}

	// 7. Build/buy specific risks.
	input.buildBuy.forEach((t, i) => {
		if (t.verdict === "build") {
			risks.push({
				id: `rk_buildRisk${i + 1}`,
				title: `Building "${t.capability}": delivery, maintenance and key-person risk; check open-source licence obligations`,
				category: "operations",
				likelihood: 0.4,
				severity: 0.6,
				mitigation: "Time-box an MVP, review dependency licences, and document ownership of the code.",
				finding_ids: [],
			})
		} else {
			risks.push({
				id: `rk_vendorLock${i + 1}`,
				title: `Buying "${t.capability}": vendor viability and lock-in`,
				category: "operations",
				likelihood: 0.3,
				severity: 0.5,
				mitigation: "Negotiate data export and exit terms; shortlist a second vendor.",
				finding_ids: [],
			})
		}
	})

	risks.sort((a, b) => b.likelihood * b.severity - a.likelihood * a.severity || a.id.localeCompare(b.id))
	return { risks, breakpoints, liquidityWarning }
}
