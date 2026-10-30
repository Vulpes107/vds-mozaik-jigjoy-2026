import type { BusinessPlan, Scenario } from "../types/contracts.ts"
import { compact, label, pct } from "../fmt.ts"
import { Section, RangeBar } from "../ui.tsx"

export function Decision({ plan, scenarios }: { plan?: BusinessPlan; scenarios: Scenario[] }) {
	if (!plan) return <Section id="decision" n="02" title="Decision"><p className="note">Waiting for the plan.</p></Section>
	const d = plan.decisions
	const scores = Object.entries(d.continue_vs_change.scores).sort((a, b) => b[1] - a[1])
	const chosen = scenarios.find((s) => s.id === plan.chosen_scenario_id)
	let run = 0
	const ticks = (chosen?.tranches ?? []).map((t) => (run += t.amount))
	const inv = d.investment
	return (
		<Section id="decision" n="02" title="Decision" lede="Five options scored against each other, the money needed to pursue the leading one, and where building beats buying.">
			<div className="grid2">
				<div>
					<h3 className="sub">Options, ranked (heuristic scores, not probabilities)</h3>
					<ol className="rank">
						{scores.map(([k, v], i) => (
							<li key={k} className={i === 0 ? "top" : ""}>
								<span>{label(k)}</span>
								<span className="track"><i style={{ width: `${v * 100}%` }} /></span>
								<span className="num">{v.toFixed(2)}</span>
							</li>
						))}
					</ol>
					{d.continue_vs_change.rationale && <p className="note" style={{ marginTop: 10 }}>{d.continue_vs_change.rationale}</p>}
				</div>
				<div>
					<h3 className="sub">Investment range ({inv.currency}){inv.staged ? ", released in tranches" : ""}</h3>
					<RangeBar min={inv.low * 0.9} max={inv.high * 1.05} low={inv.low} base={inv.base} high={inv.high} ticks={ticks.filter((t) => t >= inv.low * 0.9 && t <= inv.high * 1.05)} fmt={compact} ariaLabel="Investment" />
					<p className="note" style={{ marginTop: 28 }}>
						Tick marks show cumulative tranche releases{ticks.length ? `: ${ticks.map(compact).join(", ")}` : " (none recorded)"}. {inv.rationale}
					</p>
				</div>
			</div>
			{(d.build_vs_buy?.length ?? 0) > 0 && (
				<>
					<h3 className="sub">Build, buy or partner</h3>
					<table>
						<thead>
							<tr><th>Capability</th><th>Verdict</th><th className="r">Build TCO</th><th className="r">Buy TCO</th><th>Flip point</th></tr>
						</thead>
						<tbody>
							{d.build_vs_buy!.map((b) => (
								<tr key={b.capability}>
									<td>{b.capability}</td>
									<td><strong>{b.verdict}</strong></td>
									<td className="num">{compact(b.tco_build)}</td>
									<td className="num">{compact(b.tco_buy)}</td>
									<td>{b.flip_point ?? "—"}<div className="flip">{b.horizon_years}-year horizon{b.candidate_vendors?.length ? ` · ${b.candidate_vendors.join(", ")}` : ""}</div></td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
			<p className="foot">Overall confidence {pct(plan.overall_confidence ?? 0)}. Scores rank the options against each other; they are not forecasts.</p>
		</Section>
	)
}
