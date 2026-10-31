// Pure derivations from contract objects. No React, so they are unit-tested directly.
import type { AgentEvent, Assumption, BusinessPlan, Scenario, Topic } from "./types/contracts.ts"

export const effective = (a: Assumption): number => a.user_override ?? a.base
export const isPinned = (a: Assumption): boolean => a.user_override !== null && a.user_override !== undefined

// ---------- agent allocation ----------
export interface AgentPos {
	id: string
	role: string
	topicId: string | null // null = idle
}
/**
 * Where every agent stands after the first `upTo` events. An agent's starting spot is read from the first event that
 * mentions it (its from_topic_id when reassigned, else its topic), so replay works from any scrubber position.
 * Agents the stream never mentions keep the placement recorded on the topics.
 */
export function allocationAt(events: AgentEvent[], topics: Topic[], upTo: number): AgentPos[] {
	const agents = new Map<string, AgentPos>()
	const seen = events.slice(0, upTo)
	for (const e of events) {
		if (!e.agent_id || agents.has(e.agent_id)) continue
		const start = e.type === "agent_reassigned" ? (e.from_topic_id ?? null) : (e.topic_id ?? null)
		agents.set(e.agent_id, { id: e.agent_id, role: e.agent_role ?? "collector", topicId: start })
	}
	for (const t of topics)
		for (const a of t.assigned_agents ?? []) if (!agents.has(a)) agents.set(a, { id: a, role: "collector", topicId: t.id })
	for (const e of seen) {
		if (!e.agent_id) continue
		const a = agents.get(e.agent_id)
		if (!a) continue
		if (e.agent_role) a.role = e.agent_role
		if (e.type === "agent_reassigned" || e.type === "agent_assigned" || e.type === "agent_spawned") a.topicId = e.topic_id ?? a.topicId
		if (e.type === "agent_idle" || e.type === "agent_failed") a.topicId = null
	}
	return [...agents.values()].sort((x, y) => x.id.localeCompare(y.id))
}

/** Topic states as of the replay position (only drops are knowable from the stream). */
export function droppedAt(events: AgentEvent[], upTo: number): Set<string> {
	return new Set(events.slice(0, upTo).filter((e) => e.type === "topic_dropped" && e.topic_id).map((e) => e.topic_id!))
}

// ---------- cash curve ----------
export interface CashPoint {
	month: number
	cash: number
}
/**
 * Cumulative cash reconstructed from yearly totals (revenue - opex spread evenly over 12 months) and capex released
 * by tranche (or all at month 0). Contingency lifts capex. Yearly resolution only; the engine's own monthly figures
 * are authoritative, so the UI labels this as a reconstruction.
 */
export function cashCurve(s: Scenario, opening: number): CashPoint[] {
	const years = Math.max(s.revenue_by_year.length, s.opex_by_year.length)
	const lift = 1 + (s.contingency_pct ?? 0) / 100
	const capexAt = new Map<number, number>()
	if (s.tranches?.length) for (const t of s.tranches) capexAt.set(t.month, (capexAt.get(t.month) ?? 0) + t.amount * lift)
	else if (s.capex) capexAt.set(0, s.capex * lift)
	const out: CashPoint[] = []
	let cash = opening
	for (let m = 0; m <= years * 12; m++) {
		if (m > 0) {
			const y = Math.floor((m - 1) / 12)
			cash += ((s.revenue_by_year[y] ?? 0) - (s.opex_by_year[y] ?? 0)) / 12
		}
		cash -= capexAt.get(m) ?? 0
		out.push({ month: m, cash })
	}
	return out
}
export function firstBelowZero(c: CashPoint[]): number | null {
	return c.find((p) => p.cash < 0)?.month ?? null
}

// ---------- scenarios ----------
export interface ScenarioGroup {
	kind: Scenario["kind"]
	name: string
	base: Scenario
	low?: Scenario
	high?: Scenario
}
export function groupScenarios(all: Scenario[]): ScenarioGroup[] {
	const groups = new Map<string, ScenarioGroup>()
	for (const s of all.filter((x) => (x.case ?? "base") === "base")) groups.set(s.kind, { kind: s.kind, name: s.name, base: s })
	for (const s of all) {
		const g = groups.get(s.kind)
		if (g && s.case === "low") g.low = s
		if (g && s.case === "high") g.high = s
	}
	return [...groups.values()]
}

// ---------- risks / misc ----------
export const riskScore = (r: BusinessPlan["risks"][number]): number => r.likelihood * r.severity

/** Overall confidence below this softens the whole UI and says why. */
export const LOW_CONFIDENCE = 0.4

export function toMarkdown(plan: BusinessPlan, scenarios: Scenario[], assumptions: Assumption[]): string {
	const L: string[] = [`# Strategy report`, `_Generated ${plan.generated_at.slice(0, 10)}. Overall confidence ${Math.round((plan.overall_confidence ?? 0) * 100)}%._`, "", "## Summary", plan.executive_summary, "", "## Recommendations"]
	for (const r of plan.recommendations) L.push(`${r.rank}. **${r.title}** (confidence ${Math.round(r.confidence * 100)}%). ${r.rationale}${r.what_would_change_this ? ` _Would change if:_ ${r.what_would_change_this}` : ""}`)
	const d = plan.decisions
	L.push("", "## Decision", `Verdict: **${d.continue_vs_change.verdict}**. ${d.continue_vs_change.rationale ?? ""}`)
	L.push(`Investment range: ${d.investment.low}–${d.investment.high} ${d.investment.currency} (base ${d.investment.base}${d.investment.staged ? ", staged" : ""}).`)
	for (const b of d.build_vs_buy ?? []) L.push(`- ${b.capability}: **${b.verdict}** (build ${b.tco_build}, buy ${b.tco_buy} over ${b.horizon_years} y). ${b.flip_point ?? ""}`)
	L.push("", "## Scenarios")
	for (const s of scenarios) L.push(`- ${s.name} (${s.case ?? "base"}): NPV ${s.metrics?.npv ?? "n/a"}, payback ${s.metrics?.payback_months ?? "n/a"} months${s.metrics?.runway_breached ? ", RUNWAY BREACHED" : ""}`)
	L.push("", "## Assumptions")
	for (const a of assumptions) L.push(`- ${a.text}: ${a.low} / ${effective(a)} / ${a.high} ${a.unit}${isPinned(a) ? " (user override)" : ""}`)
	L.push("", "## Risks")
	for (const r of [...plan.risks].sort((a, b) => riskScore(b) - riskScore(a))) L.push(`- ${r.title} (likelihood ${r.likelihood}, severity ${r.severity}). Mitigation: ${r.mitigation}`)
	L.push("", `> ${plan.disclaimer}`)
	return L.join("\n")
}

// ---------- plain-language readings of each chart (generated from the data, so they never go stale) ----------
const k = (n: number): string => {
	const a = Math.abs(n)
	const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`
	return n < 0 ? `−${s}` : s
}

export interface CashFacts {
	name: string
	lowMonth: number
	lowValue: number
	belowFrom: number | null
	recoversAt: number | null
	end: number
}
export function cashFacts(name: string, pts: CashPoint[]): CashFacts {
	const low = pts.reduce((m, p) => (p.cash < m.cash ? p : m), pts[0]!)
	const below = firstBelowZero(pts)
	const rec = below === null ? null : (pts.find((p) => p.month > below && p.cash >= 0)?.month ?? null)
	return { name, lowMonth: low.month, lowValue: low.cash, belowFrom: below, recoversAt: rec, end: pts[pts.length - 1]!.cash }
}
export function cashStory(facts: CashFacts[], cur: string): string[] {
	return facts.map((f) => {
		if (f.belowFrom === null) return `${f.name}: cash never drops below zero. Lowest point ${k(f.lowValue)} ${cur} (month ${f.lowMonth}); ends at ${k(f.end)}.`
		const back = f.recoversAt === null ? "and does not recover within the horizon" : `and is back above zero in month ${f.recoversAt}`
		return `${f.name}: cash goes below zero in month ${f.belowFrom}, bottoms out at ${k(f.lowValue)} ${cur} in month ${f.lowMonth}, ${back}. Ends at ${k(f.end)}.`
	})
}

export function npvStory(groups: ScenarioGroup[], cur: string): string[] {
	const rows = groups.filter((g) => g.base.metrics?.npv !== undefined).sort((a, b) => b.base.metrics!.npv! - a.base.metrics!.npv!)
	if (!rows.length) return ["No scenario has been valued yet."]
	const out = [`Highest base-case value: ${rows[0]!.name} at ${k(rows[0]!.base.metrics!.npv!)} ${cur}.`]
	const base = groups.find((g) => g.kind === "do_nothing")
	if (base && rows[0] !== undefined && rows[0].kind !== "do_nothing") out.push(`That is ${k(rows[0].base.metrics!.npv! - (base.base.metrics?.npv ?? 0))} ${cur} better than doing nothing.`)
	const breached = groups.filter((g) => g.base.metrics?.runway_breached).map((g) => g.name)
	if (breached.length) out.push(`${breached.join(", ")} runs out of cash before it recovers, so a higher value does not mean it is affordable (see the cash chart).`)
	out.push(groups.some((g) => g.low) ? "Each bar spans the adverse to the favourable case." : "Only the base case exists, so no uncertainty band is drawn yet.")
	return out
}

export function mapStory(topics: Topic[]): string[] {
	const live = topics.filter((t) => t.state !== "dropped" && t.confidence !== undefined)
	const need = live.filter((t) => (t.impact ?? t.importance_prior) >= 0.5 && (t.confidence ?? 0) < 0.5)
	const out: string[] = []
	if (need.length) out.push(`${need.map((t) => t.id).join(", ")} matter a lot but are poorly evidenced. More research would change the plan most here.`)
	else if (live.length) out.push("No high-impact topic is poorly evidenced.")
	const inc = topics.filter((t) => t.state === "research_incomplete")
	if (inc.length) out.push(`${inc.length} topic${inc.length > 1 ? "s" : ""} could not be finished (${inc.map((t) => t.id).join(", ")}). Hollow markers.`)
	const dr = topics.filter((t) => t.state === "dropped")
	if (dr.length) out.push(`${dr.length} dropped as irrelevant: ${dr.map((t) => `${t.id} (${t.state_reason ?? "low relevance"})`).join("; ")}`)
	return out
}

export function riskStory(risks: BusinessPlan["risks"]): string[] {
	if (!risks.length) return []
	const s = [...risks].sort((a, b) => riskScore(b) - riskScore(a))
	const hot = s.filter((r) => riskScore(r) >= 0.4)
	return [`${hot.length} of ${s.length} risks score 0.40 or more (likelihood × severity).`, `Largest: ${s[0]!.title} (${riskScore(s[0]!).toFixed(2)}).`]
}

export function moveStory(events: AgentEvent[], upTo: number): string | null {
	const e = events.slice(0, upTo).filter((x) => x.type === "agent_reassigned").at(-1)
	if (!e) return null
	return `${e.agent_id} moved ${e.from_topic_id ? `from ${e.from_topic_id} ` : ""}to ${e.topic_id}${e.detail ? `: ${e.detail.charAt(0).toLowerCase()}${e.detail.slice(1)}` : ""}.`
}

export function sourceStats(sources: { reliability: number; injection_flagged?: boolean; source_type?: string }[]) {
	const n = sources.length
	return { n, flagged: sources.filter((s) => s.injection_flagged).length, avg: n ? sources.reduce((a, s) => a + s.reliability, 0) / n : 0, weak: sources.filter((s) => s.reliability < 0.5).length }
}
