import type { Topic } from "../types/contracts.ts"
import { label } from "../fmt.ts"
import { Chip, Section } from "../ui.tsx"

const STATES: Topic["state"][] = ["queued", "scouting", "deep", "shallow", "closed", "dropped", "research_incomplete"]

export function Research({ topics }: { topics: Topic[] }) {
	const W = 520, H = 300, L = 44, B = 30, T = 12, R = 16
	const plotted = topics.filter((t) => t.confidence !== undefined && t.state !== "dropped")
	const imp = (t: Topic) => t.impact ?? t.importance_prior
	const x = (c: number) => L + c * (W - L - R)
	const y = (i: number) => T + (1 - i) * (H - T - B)
	const dropped = topics.filter((t) => t.state === "dropped")
	const incomplete = topics.filter((t) => t.state === "research_incomplete")
	return (
		<Section id="research" n="04" title="Research map" lede="Each topic by how much it matters to the decision against how sure we are. Top-left is where more research pays off most.">
			{topics.length === 0 ? <p className="note">No topics yet. The planner proposes them after the company profile is submitted.</p> : (
				<div className="grid2">
					<div>
						<svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Topics by impact and confidence">
							<rect x={L} y={T} width={(W - L - R) / 2} height={(H - T - B) / 2} fill="var(--warn-bg)" opacity="0.7" />
							<text x={L + 8} y={T + 18} style={{ fill: "var(--warn)" }}>Needs research</text>
							<line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--ink)" />
							<line x1={L} x2={L} y1={T} y2={y(0)} stroke="var(--ink)" />
							{[0, 0.5, 1].map((v) => (
								<g key={v}>
									<text x={x(v)} y={H - 10} textAnchor="middle">{v}</text>
									<text x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text>
								</g>
							))}
							<text x={(L + W - R) / 2} y={H} textAnchor="middle">confidence in what we found</text>
							<text transform={`translate(10 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">impact on decision</text>
							{plotted.map((t) => (
								<g key={t.id} className="pt" transform={`translate(${x(t.confidence!)} ${y(imp(t))})`}>
									<circle r="6" fill={t.state === "research_incomplete" ? "var(--bg)" : "var(--ink)"} stroke={t.state === "research_incomplete" ? "var(--warn)" : "var(--bg)"} strokeWidth="2" />
									<text x="10" y="4">{t.id}</text>
									<title>{`${t.title}: impact ${imp(t)}, confidence ${t.confidence}, ${label(t.state)}`}</title>
								</g>
							))}
						</svg>
						<p className="note">Dropped topics are not plotted; they are listed on the right with the reason.</p>
					</div>
					<div>
						<h3 className="sub">Topics</h3>
						<table>
							<thead><tr><th>Topic</th><th>State</th><th className="r">Priority</th></tr></thead>
							<tbody>
								{[...topics].sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state)).map((t) => (
									<tr key={t.id}>
										<td><span className="asof">{t.id}</span> {t.title}{t.state_reason && <div className="flip">{t.state_reason}</div>}</td>
										<td><Chip kind={t.state} /></td>
										<td className="num">{t.priority !== undefined ? t.priority.toFixed(2) : "—"}</td>
									</tr>
								))}
							</tbody>
						</table>
						{(dropped.length > 0 || incomplete.length > 0) && (
							<p className="note" style={{ marginTop: 10 }}>{dropped.length} dropped on purpose, {incomplete.length} could not be completed. Both are carried into the plan's confidence.</p>
						)}
					</div>
				</div>
			)}
		</Section>
	)
}
