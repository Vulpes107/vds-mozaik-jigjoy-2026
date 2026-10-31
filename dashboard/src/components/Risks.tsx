import { Fragment } from "react"
import type { BusinessPlan } from "../types/contracts.ts"
import { riskScore, riskStory } from "../derive.ts"
import { Figure, Section } from "../ui.tsx"

const bin = (x: number) => (x < 0.34 ? 0 : x < 0.67 ? 1 : 2)
const NAMES = ["low", "medium", "high"]

export function Risks({ plan }: { plan?: BusinessPlan }) {
	const risks = [...(plan?.risks ?? [])].sort((a, b) => riskScore(b) - riskScore(a))
	const road = [...(plan?.roadmap ?? [])].sort((a, b) => a.month - b.month)
	return (
		<Section id="risks" title="What could go wrong, and when we stop" lede="The main threats to the plan, and the checkpoints where money is held back if things go badly.">
			{risks.length === 0 ? <p className="note">No risks recorded yet.</p> : (
				<Figure
					title="Risk matrix"
					question="Which risks are both likely and serious?"
					read={[
						"Each numbered dot is a risk from the list below. Further right = more likely. Higher = more damage if it happens.",
						"Amber and red cells are where likelihood and severity combine into the most pressing risks.",
						"Ratings are judgement calls by the red-team step, not measurements.",
					]}
					now={riskStory(risks)}
				>
					<div className="matrix" role="img" aria-label="Risk matrix: likelihood against severity">
						{[2, 1, 0].map((sev) => (
							<Fragment key={sev}>
								<div className="axl v"><span>{NAMES[sev]} severity</span></div>
								{[0, 1, 2].map((lik) => (
									<div key={`${sev}${lik}`} className={`cell${sev + lik >= 4 ? " h3" : sev + lik >= 3 ? " h2" : ""}`}>
										{risks.map((r, i) => (bin(r.severity) === sev && bin(r.likelihood) === lik ? <span key={r.id} className="dot" title={r.title}>{i + 1}</span> : null))}
									</div>
								))}
							</Fragment>
						))}
						<div />
						{NAMES.map((n) => <div key={n} className="axl">{n} likelihood</div>)}
					</div>
				</Figure>
			)}
			<div className="cols-7-5">
				<div>
					<h3 className="sub">Risks and how to reduce them</h3>
					{risks.length === 0 ? <p className="note">None yet.</p> : (
						<table>
							<thead><tr><th>#</th><th>Risk</th><th className="r">Likelihood × severity</th></tr></thead>
							<tbody>
								{risks.map((r, i) => (
									<tr key={r.id}>
										<td className="num" style={{ textAlign: "left" }}>{i + 1}</td>
										<td><strong>{r.title}</strong>{r.category && <span className="asof"> · {r.category}</span>}<div className="flip">Mitigation: {r.mitigation}</div></td>
										<td className="num">{r.likelihood.toFixed(2)} × {r.severity.toFixed(2)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
				<div>
					<h3 className="sub">Roadmap and stop points</h3>
					{road.length === 0 ? <p className="note">No roadmap yet.</p> : (
						<ol className="road">
							{road.map((m, i) => (
								<li key={i} className={m.gate ? "gate" : ""}>
									<span className="mo">Month {m.month}</span>
									<span className="node" aria-hidden="true" />
									<div>
										<strong>{m.milestone}</strong>{m.gate && <span className="asof"> · gate (◆)</span>}
										{m.kill_criteria?.map((k) => <div key={k} className="kill">{k}</div>)}
									</div>
								</li>
							))}
						</ol>
					)}
					<p className="note">At a gate (◆), if a stop condition is met the next step of funding does not go ahead.</p>
				</div>
			</div>
		</Section>
	)
}
