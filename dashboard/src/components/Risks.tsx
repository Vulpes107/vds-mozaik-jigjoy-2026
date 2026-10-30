import { Fragment } from "react"
import type { BusinessPlan } from "../types/contracts.ts"
import { riskScore } from "../derive.ts"
import { Section } from "../ui.tsx"

const bin = (x: number) => (x < 0.34 ? 0 : x < 0.67 ? 1 : 2)
const NAMES = ["low", "medium", "high"]

export function Risks({ plan }: { plan?: BusinessPlan }) {
	const risks = [...(plan?.risks ?? [])].sort((a, b) => riskScore(b) - riskScore(a))
	return (
		<Section id="risks" n="06" title="Risk register" lede="Ranked by likelihood times severity. Ratings are judgement calls made by the red-team step, not measurements.">
			{risks.length === 0 ? <p className="note">No risks recorded yet.</p> : (
				<div className="grid2">
					<div>
						<div className="matrix" role="img" aria-label="Risk matrix: likelihood against severity">
							{[2, 1, 0].map((sev) => (
								<Fragment key={sev}>
									<div className="axl v"><span>{NAMES[sev]}</span></div>
									{[0, 1, 2].map((lik) => (
										<div key={`${sev}${lik}`} className={`cell${sev + lik >= 4 ? " h3" : sev + lik >= 3 ? " h2" : ""}`}>
											{risks.map((r, i) => (bin(r.severity) === sev && bin(r.likelihood) === lik ? <span key={r.id} className="dot" title={r.title}>{i + 1}</span> : null))}
										</div>
									))}
								</Fragment>
							))}
							<div />
							{NAMES.map((n) => <div key={n} className="axl">{n}</div>)}
						</div>
						<p className="note" style={{ marginTop: 6 }}>Columns: likelihood. Rows: severity. Numbers match the list.</p>
					</div>
					<div>
						<table>
							<thead><tr><th>#</th><th>Risk</th><th className="r">L × S</th></tr></thead>
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
					</div>
				</div>
			)}
		</Section>
	)
}
