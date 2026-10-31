import { useState } from "react"
import type { Assumption, BusinessPlan, Finding, Scenario } from "../types/contracts.ts"
import { effective } from "../derive.ts"
import { compact, label, pct } from "../fmt.ts"
import { RangeBar, Section } from "../ui.tsx"

function Why({ plan, rec, findings, scenarios, assumptions }: { plan: BusinessPlan; rec: BusinessPlan["recommendations"][number]; findings: Map<string, Finding>; scenarios: Scenario[]; assumptions: Assumption[] }) {
	const sc = scenarios.filter((s) => rec.scenario_ids?.includes(s.id))
	const as = assumptions.filter((a) => sc.some((s) => s.assumption_ids.includes(a.id)) || plan.assumption_ids.includes(a.id))
	return (
		<div className="why">
			<strong>Evidence behind this</strong>
			<ul>
				{rec.finding_ids.length === 0 && <li>No findings cited. Treat this as judgement.</li>}
				{rec.finding_ids.map((id) => <li key={id}>{findings.get(id)?.claim ?? `${id} (not found)`} <span className="asof">{id}</span></li>)}
			</ul>
			<strong style={{ display: "block", marginTop: 10 }}>Assumptions it depends on</strong>
			<ul>{as.map((a) => <li key={a.id}>{a.text}: <span className="num">{effective(a)}</span> {a.unit} (range {a.low}–{a.high})</li>)}</ul>
		</div>
	)
}

export function Recommendation({ plan, scenarios, findings, assumptions }: { plan: BusinessPlan; scenarios: Scenario[]; findings: Finding[]; assumptions: Assumption[] }) {
	const [open, setOpen] = useState<number | null>(null)
	const byId = new Map(findings.map((f) => [f.id, f]))
	const d = plan.decisions
	const scores = Object.entries(d.continue_vs_change.scores).sort((a, b) => b[1] - a[1])
	const chosen = scenarios.find((s) => s.id === plan.chosen_scenario_id)
	let run = 0
	const ticks = (chosen?.tranches ?? []).map((t) => (run += t.amount))
	const inv = d.investment
	const lo = inv.low * 0.9, hi = inv.high * 1.05
	return (
		<Section id="recommend" title="What we recommend" lede="The actions, ranked, with the evidence behind each. On the right: how the modelled strategic options compare and how much money is needed.">
			<div className="cols-7-5">
				<div>
					<h3 className="sub">Actions, in priority order</h3>
					<ol className="recs">
						{plan.recommendations.map((r, i) => (
							<li key={r.rank} className="rec">
								<span className="n">{r.rank}</span>
								<div>
									<h3>{r.title} <span className="asof">confidence {pct(r.confidence)}</span></h3>
									<p>{r.rationale}</p>
									{r.what_would_change_this && <p className="note">Would change if: {r.what_would_change_this}</p>}
									<button className="btn link" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>Why this?</button>
									{open === i && <Why plan={plan} rec={r} findings={byId} scenarios={scenarios} assumptions={assumptions} />}
								</div>
							</li>
						))}
					</ol>
					{(d.build_vs_buy?.length ?? 0) > 0 && (
						<>
							<h3 className="sub" style={{ marginTop: 24 }}>Build, buy or partner</h3>
							<table>
								<thead><tr><th>Capability</th><th>Verdict</th><th className="r">Build cost</th><th className="r">Buy cost</th><th>When the answer flips</th></tr></thead>
								<tbody>
									{d.build_vs_buy!.map((b) => (
										<tr key={b.capability}>
											<td>{b.capability}</td>
											<td><strong>{b.verdict}</strong></td>
											<td className="num">{compact(b.tco_build)}</td>
											<td className="num">{compact(b.tco_buy)}</td>
											<td>{b.flip_point ?? "—"}<div className="flip">Total cost over {b.horizon_years} years{b.candidate_vendors?.length ? ` · vendors: ${b.candidate_vendors.join(", ")}` : ""}</div></td>
										</tr>
									))}
								</tbody>
							</table>
						</>
					)}
				</div>
				<div className="stack">
					<div>
						<h3 className="sub">{scores.length === 1 ? "One option modelled" : `${scores.length} options compared`}</h3>
						<ol className="rank">
							{scores.map(([k, v], i) => (
								<li key={k} className={i === 0 ? "top" : ""}>
									<span>{label(k)}</span>
									<span className="track"><i style={{ width: `${v * 100}%` }} /></span>
									<span className="num">{v.toFixed(2)}</span>
								</li>
							))}
						</ol>
						<p className="note">Longer bar = better fit. Heuristic scores that rank the options against each other; they are not probabilities.{d.continue_vs_change.rationale ? ` ${d.continue_vs_change.rationale}` : ""}</p>
					</div>
					<div>
						<h3 className="sub">Money needed ({inv.currency}){inv.staged ? ", in steps" : ""}</h3>
						<RangeBar min={lo} max={hi} low={inv.low} base={inv.base} high={inv.high} ticks={ticks.filter((t) => t >= lo && t <= hi)} fmt={compact} ariaLabel="Investment" />
						<p className="note" style={{ marginTop: 26 }}>
							Grey band: low to high estimate. Black marker: base case ({compact(inv.base)}). {ticks.length ? `Teal ticks: cumulative amount released after each step (${ticks.map(compact).join(", ")}).` : ""} {inv.rationale}
						</p>
					</div>
				</div>
			</div>
		</Section>
	)
}
