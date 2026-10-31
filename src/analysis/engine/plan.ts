// Assembles the contract-shaped BusinessPlan. Every figure comes from the engine; the LLM may only supply prose
// (executive summary text and recommendation wording), which is validated and then wrapped with the computed facts.
import { kindToOption, scoreOptions, sizeInvestment, type Appetite, type Decision, type Investment, type Option, type OptionInput } from "./decisions.ts"
import { round } from "./finance.ts"
import { redTeam, type Breakpoint } from "./redteam.ts"
import { compileSpec, computeCompiled, indexAssumptions, type CompiledSpec } from "./scenario.ts"
import { tornado, type TornadoRow } from "./sensitivity.ts"
import type { TcoResult } from "./tco.ts"
import type { Assumption, Risk, Scenario, ScenarioSpec } from "./types.ts"

export const DISCLAIMER = "Not legal, tax or financial advice. Figures are model estimates with stated ranges, not forecasts."

export interface Recommendation {
	rank: number
	title: string
	rationale: string
	category?: "strategy" | "finance" | "product" | "market" | "risk" | "operations" | "other"
	confidence: number
	finding_ids: string[]
	scenario_ids?: string[]
	what_would_change_this?: string
}

export interface Narrative {
	executive_summary?: string
	recommendations?: Omit<Recommendation, "rank">[]
}

export interface BuildBuyInput extends TcoResult {
	candidate_vendors?: string[]
	finding_ids?: string[]
}

export interface PlanInput {
	runId: string
	projectId?: string
	now: Date
	profile?: {
		risk_appetite?: Appetite
		countries?: string[]
		financials?: { cash_on_hand?: number; monthly_burn?: number }
	}
	assumptions: readonly Assumption[]
	specs: readonly ScenarioSpec[]
	findings: readonly { id: string }[]
	topics: readonly { id: string; state: string }[]
	buildBuy: readonly BuildBuyInput[]
	narrative?: Narrative
}

export interface BusinessPlan {
	schema_version: "1.0"
	run_id: string
	project_id?: string
	generated_at: string
	overall_confidence: number
	executive_summary: string
	recommendations: Recommendation[]
	scenario_ids: string[]
	chosen_scenario_id: string
	decisions: {
		continue_vs_change: { verdict: Option; scores: Partial<Record<Option, number>>; rationale: string }
		investment: Investment
		build_vs_buy: {
			capability: string
			verdict: "build" | "buy" | "partner" | "defer"
			tco_build: number
			tco_buy: number
			horizon_years: number
			flip_point: string
			candidate_vendors?: string[]
			finding_ids?: string[]
		}[]
	}
	risks: Risk[]
	roadmap: { month: number; milestone: string; gate?: boolean; kill_criteria?: string[] }[]
	assumption_ids: string[]
	unresolved_topic_ids: string[]
	dropped_topic_ids: string[]
	disclaimer: string
}

export interface PlanOutput {
	plan: BusinessPlan
	/** Every case of every scenario (base + Low + High). */
	scenarios: Scenario[]
	tornado: TornadoRow[]
	breakpoints: Breakpoint[]
	decision: Decision
}

const UNRESOLVED_STATES = new Set(["queued", "scouting", "deep", "research_incomplete"])
const fmt = (n: number) => Math.round(n).toLocaleString("en-US")

/** Confidence in the evidence behind the numbers, weighted by how much each assumption moves the result. Unfinished topics are disclosed, not penalised. */
export function overallConfidence(assumptions: readonly Assumption[], weights: ReadonlyMap<string, number>, haveFindings: boolean): number {
	let num = 0
	let den = 0
	for (const a of assumptions) {
		if (!weights.has(a.id)) continue
		const w = (weights.get(a.id) as number) + 1
		let c = a.confidence ?? 0.3
		if (a.origin === "default") c = Math.min(c, 0.5)
		num += w * c
		den += w
	}
	let conf = den ? num / den : 0.3
	if (!haveFindings) conf *= 0.6
	return round(Math.max(0, Math.min(1, conf)), 2)
}

export function assemblePlan(input: PlanInput): PlanOutput {
	if (!input.specs.some((s) => s.kind === "do_nothing")) {
		throw new Error('A scenario with kind "do_nothing" is required as the baseline')
	}
	const compiled = input.specs.map(compileSpec)
	const byId = indexAssumptions(input.assumptions)
	const opts = { runId: input.runId, ...(input.projectId ? { projectId: input.projectId } : {}) }

	// All cases of all scenarios.
	const cases = compiled.map((cs) => ({
		cs,
		base: computeCompiled(cs, byId, { ...opts, case: "base" }),
		low: computeCompiled(cs, byId, { ...opts, case: "low" }),
		high: computeCompiled(cs, byId, { ...opts, case: "high" }),
	}))
	const scenarios = cases.flatMap((c) => [c.base, c.low, c.high])

	// Influence of each assumption (max NPV swing over specs) -> weights for confidence.
	const weights = new Map<string, number>()
	const rowsBySpec = new Map<string, TornadoRow[]>()
	for (const c of cases) {
		const rows = tornado(c.cs, input.assumptions, Number.MAX_SAFE_INTEGER)
		rowsBySpec.set(c.cs.spec.id, rows)
		for (const r of rows) weights.set(r.assumption_id, Math.max(weights.get(r.assumption_id) ?? 0, r.swing))
	}
	const unresolved = input.topics.filter((t) => UNRESOLVED_STATES.has(t.state)).map((t) => t.id)
	const dropped = input.topics.filter((t) => t.state === "dropped").map((t) => t.id)
	const confidence = overallConfidence(input.assumptions, weights, input.findings.length > 0)

	// Best (highest base NPV) scenario per strategic option.
	const best = new Map<Option, (typeof cases)[number]>()
	for (const c of cases) {
		const opt = kindToOption(c.base.kind)
		if (!opt) continue
		const cur = best.get(opt)
		if (!cur || c.base.metrics.npv > cur.base.metrics.npv) best.set(opt, c)
	}
	const optionInputs: OptionInput[] = [...best.entries()].map(([option, c]) => ({ option, base: c.base, low: c.low }))
	const decision = scoreOptions(optionInputs, input.profile?.risk_appetite ?? "medium", confidence)
	const chosen = best.get(decision.verdict)!
	const baseline = best.get("continue")!

	const chosenRows = rowsBySpec.get(chosen.cs.spec.id) as TornadoRow[]
	const rt = redTeam({
		chosen: { spec: chosen.cs, base: chosen.base, low: chosen.low },
		baseline: { spec: baseline.cs, base: baseline.base },
		assumptions: input.assumptions,
		tornado: chosenRows,
		profile: input.profile,
		unresolvedTopicIds: unresolved,
		buildBuy: input.buildBuy,
	})

	const investment =
		decision.verdict === "continue"
			? { currency: chosen.base.currency, low: 0, base: 0, high: 0, staged: false, rationale: "No new capital is required to continue as is." }
			: sizeInvestment(chosen.base, chosen.low, chosen.high)

	// Recommendations: model prose (validated) or a deterministic fallback; liquidity always leads.
	const knownFindings = new Set(input.findings.map((f) => f.id))
	const chosenBasis = [...new Set(chosen.base.assumption_ids.flatMap((id) => (byId.get(id)?.basis_finding_ids ?? []).filter((f) => knownFindings.has(f))))]
	const changeNote =
		rt.breakpoints[0]?.statement ?? "No single key assumption reverses this recommendation within its modelled range."
	const recs: Omit<Recommendation, "rank">[] = []
	if (rt.liquidityWarning) {
		recs.push({
			title: "Secure liquidity before committing capital",
			rationale: rt.liquidityWarning,
			category: "finance",
			confidence: Math.min(0.9, round(confidence + 0.2, 2)),
			finding_ids: chosenBasis,
			scenario_ids: [chosen.base.id],
			what_would_change_this: "Confirmed funding or a smaller first tranche that keeps the cash balance positive.",
		})
	}
	if (input.narrative?.recommendations?.length) {
		for (const r of input.narrative.recommendations) {
			const unknown = r.finding_ids.filter((f) => !knownFindings.has(f))
			if (unknown.length) throw new Error(`Recommendation "${r.title}" cites unknown finding ids: ${unknown.join(", ")}`)
			recs.push(r)
		}
	} else {
		const titles: Record<Option, string> = {
			continue: "Continue current operations; do not commit new capital",
			optimise: "Optimise the existing business before investing",
			expand: "Expand in stages with gates",
			pivot: "Pivot in stages with gates",
			exit: "Plan an orderly exit",
		}
		recs.push({
			title: titles[decision.verdict],
			rationale: `${decision.rationale} Base-case NPV ${fmt(chosen.base.metrics.npv)} ${chosen.base.currency} versus ${fmt(baseline.base.metrics.npv)} for continuing.`,
			category: "strategy",
			confidence,
			finding_ids: chosenBasis,
			scenario_ids: [...new Set([chosen.base.id, baseline.base.id])],
			what_would_change_this: changeNote,
		})
		for (const t of input.buildBuy) {
			recs.push({
				title: `${t.verdict === "build" ? "Build" : t.verdict === "buy" ? "Buy" : "Partner for"} ${t.capability}`,
				rationale: `${t.horizon_years}-year TCO: build ${fmt(t.build.total)} vs buy ${fmt(t.buy.total)}. ${t.flip_point}`,
				category: "product",
				confidence,
				finding_ids: (t.finding_ids ?? []).filter((f) => knownFindings.has(f)),
				what_would_change_this: t.flip_point,
			})
		}
	}
	const recommendations: Recommendation[] = recs.map((r, i) => ({ ...r, rank: i + 1 }))

	// Roadmap from the chosen option's tranches (gate i reviews tranche i-1's kill criteria, as in the fixtures).
	const roadmap: BusinessPlan["roadmap"] = []
	const tr = chosen.base.tranches ?? []
	if (tr.length) {
		tr.forEach((t, i) => {
			if (i === 0) roadmap.push({ month: t.month, milestone: `Tranche 1 released (${fmt(t.amount)} ${chosen.base.currency})`, gate: false })
			else {
				roadmap.push({
					month: t.month,
					milestone: `Gate review before tranche ${i + 1} (${fmt(t.amount)} ${chosen.base.currency})`,
					gate: true,
					kill_criteria: tr[i - 1]!.kill_criteria,
				})
			}
		})
	} else {
		roadmap.push({ month: 0, milestone: `Start: ${decision.verdict}`, gate: false })
		roadmap.push({ month: 12, milestone: "12-month review against plan", gate: true, kill_criteria: [changeNote] })
	}
	roadmap.sort((a, b) => a.month - b.month)

	// Executive summary: liquidity first, then prose, then honest caveats.
	const summaryBody =
		input.narrative?.executive_summary ??
		`Recommended direction: ${decision.verdict}. ${decision.rationale} Base-case NPV is ${fmt(chosen.base.metrics.npv)} ${chosen.base.currency} (adverse case ${fmt(chosen.low.metrics.npv)}, favourable ${fmt(chosen.high.metrics.npv)}) against ${fmt(baseline.base.metrics.npv)} for continuing.`
	const caveats: string[] = []
	if (input.findings.length === 0) caveats.push("No verified findings back these assumptions, so all figures are illustrative.")
	if (confidence < 0.5) caveats.push(`Overall confidence is low (${confidence}); treat ranges, not point values, as the result.`)
	if (unresolved.length) caveats.push(`${unresolved.length} research topic(s) did not finish.`)
	const executive_summary = [rt.liquidityWarning, summaryBody, ...caveats].filter(Boolean).join(" ")

	const tcoIds = input.buildBuy.flatMap((t) => t.assumption_ids)
	const plan: BusinessPlan = {
		schema_version: "1.0",
		run_id: input.runId,
		...(input.projectId ? { project_id: input.projectId } : {}),
		generated_at: input.now.toISOString(),
		overall_confidence: confidence,
		executive_summary,
		recommendations,
		scenario_ids: scenarios.map((s) => s.id),
		chosen_scenario_id: chosen.base.id,
		decisions: {
			continue_vs_change: { verdict: decision.verdict, scores: decision.scores, rationale: decision.rationale },
			investment,
			build_vs_buy: input.buildBuy.map((t) => ({
				capability: t.capability,
				verdict: t.verdict,
				tco_build: t.build.total,
				tco_buy: t.buy.total,
				horizon_years: t.horizon_years,
				flip_point: t.flip_point,
				...(t.candidate_vendors ? { candidate_vendors: t.candidate_vendors } : {}),
				...(t.finding_ids ? { finding_ids: t.finding_ids } : {}),
			})),
		},
		risks: rt.risks,
		roadmap,
		assumption_ids: [...new Set([...compiled.flatMap((c) => c.ids), ...tcoIds])].sort(),
		unresolved_topic_ids: unresolved,
		dropped_topic_ids: dropped,
		disclaimer: DISCLAIMER,
	}
	return { plan, scenarios, tornado: chosenRows.slice(0, 5), breakpoints: rt.breakpoints, decision }
}

export type { CompiledSpec }
