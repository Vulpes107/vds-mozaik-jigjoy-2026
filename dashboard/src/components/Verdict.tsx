import type { Assumption, BusinessPlan, Finding, Scenario, Topic } from "../types/contracts.ts"
import { LOW_CONFIDENCE } from "../derive.ts"
import { confWord, dateOnly, pct } from "../fmt.ts"
import { Banner } from "../ui.tsx"

export function lowConfidenceReasons(plan: BusinessPlan, topics: Topic[], assumptions: Assumption[], findings: Finding[]): string[] {
	const r: string[] = []
	const unresolved = plan.unresolved_topic_ids?.length ?? topics.filter((t) => t.state === "research_incomplete").length
	if (unresolved) r.push(`${unresolved} research topic${unresolved > 1 ? "s" : ""} unresolved`)
	const defaults = assumptions.filter((a) => a.origin === "default").length
	if (defaults) r.push(`${defaults} of ${assumptions.length} assumptions are defaults, not evidence`)
	const weak = findings.filter((f) => f.confidence < 0.5).length
	if (weak) r.push(`${weak} findings below 50% confidence`)
	if (findings.some((f) => (f.conflicts_with?.length ?? 0) > 0)) r.push("conflicting findings")
	return r
}

export function Verdict({ plan, scenarios, topics, assumptions, findings }: { plan?: BusinessPlan; scenarios: Scenario[]; topics: Topic[]; assumptions: Assumption[]; findings: Finding[] }) {
	if (!plan) {
		const done = topics.filter((t) => t.state === "closed" || t.state === "dropped").length
		return (
			<div className="verdict" aria-busy="true">
				<div>
					<div className="kicker">Verdict</div>
					<p className="word serif" style={{ fontSize: "clamp(40px,6vw,64px)", textTransform: "none" }}>Research in progress</p>
					<p className="summary">The recommendation appears once analysis has run. {topics.length ? `${done} of ${topics.length} topics settled so far.` : "No topics yet."}</p>
				</div>
			</div>
		)
	}
	const chosen = scenarios.find((s) => s.id === plan.chosen_scenario_id)
	const liquidity = chosen?.metrics?.runway_breached || plan.risks.some((r) => r.category === "liquidity" && r.likelihood * r.severity >= 0.3)
	const conf = plan.overall_confidence ?? 0
	const reasons = lowConfidenceReasons(plan, topics, assumptions, findings)
	const liqRisk = plan.risks.find((r) => r.category === "liquidity")
	return (
		<div className="verdict">
			{liquidity && (
				<div className="liq">
					<Banner kind="crit" title="Liquidity warning">
						Cash runs out before the investment pays back{chosen?.metrics?.min_cash_balance !== undefined && chosen.metrics.min_cash_balance < 0 ? `; lowest balance in the base case is ${chosen.metrics.min_cash_balance.toLocaleString("en-GB")} ${chosen.currency}` : ""}.
						{liqRisk ? ` ${liqRisk.mitigation}` : ""}
					</Banner>
				</div>
			)}
			<div>
				<div className="kicker">Verdict · as of {dateOnly(plan.generated_at)}</div>
				<p className="word serif">{plan.decisions.continue_vs_change.verdict}</p>
				<p className="summary">{plan.executive_summary}</p>
			</div>
			<div className="conf">
				<div className="kicker">Overall confidence</div>
				<div className="big num" style={{ textAlign: "left" }}>{pct(conf)}</div>
				<div className="conf-bar" role="img" aria-label={`Confidence ${pct(conf)}, ${confWord(conf)}`}>
					<i style={{ left: 0, width: `${conf * 100}%` }} />
					<span style={{ left: `${LOW_CONFIDENCE * 100}%` }} title="Below this line the page is softened" />
				</div>
				<p className="note">
					{confWord(conf)} confidence.{" "}
					{reasons.length ? `Held down by: ${reasons.join("; ")}.` : "No open evidence gaps recorded."}
				</p>
			</div>
		</div>
	)
}
