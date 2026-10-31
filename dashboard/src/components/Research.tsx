import type { Topic } from "../types/contracts.ts"
import { mapStory } from "../derive.ts"
import { label, pct } from "../fmt.ts"
import { Chip, Figure, Section } from "../ui.tsx"

const STATES: Topic["state"][] = ["research_incomplete", "queued", "scouting", "deep", "shallow", "closed", "dropped"]
const short = (s: string) => (s.length > 26 ? `${s.slice(0, 25)}…` : s)

export function Research({ topics }: { topics: Topic[] }) {
	const W = 560, H = 320, L = 48, B = 34, T = 12, R = 140
	const plotted = topics.filter((t) => t.confidence !== undefined && t.state !== "dropped")
	const imp = (t: Topic) => t.impact ?? t.importance_prior
	const x = (c: number) => L + c * (W - L - R)
	const y = (i: number) => T + (1 - i) * (H - T - B)
	return (
		<Section id="research" title="How well do we know it?" lede="The questions the agents investigated, how much each matters to the decision, and how sure we are of the answer.">
			{topics.length === 0 ? <p className="note">No topics yet. The planner proposes them after the company profile is submitted.</p> : (
				<>
					<Figure
						title="Importance against confidence"
						question="Where is the plan standing on weak evidence?"
						read={[
							"Each dot is a research topic. Higher = it matters more to the decision. Further right = we found stronger evidence.",
							"The shaded top-left corner holds topics that matter a lot but are poorly evidenced: the best place to spend more research.",
							"A hollow dot means the research could not be finished. Dropped topics are not plotted.",
						]}
						now={mapStory(topics)}
					>
						<svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Topics by impact and confidence">
							<rect x={L} y={T} width={(W - L - R) / 2} height={(H - T - B) / 2} fill="var(--warn-bg)" opacity="0.75" />
							<text x={L + 8} y={T + 18} style={{ fill: "var(--warn)" }}>Matters, but weakly evidenced</text>
							<line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--ink)" />
							<line x1={L} x2={L} y1={T} y2={y(0)} stroke="var(--ink)" />
							{[0, 0.5, 1].map((v) => (
								<g key={v}>
									<text x={x(v)} y={H - 16} textAnchor="middle">{v}</text>
									<text x={L - 8} y={y(v) + 4} textAnchor="end">{v}</text>
								</g>
							))}
							<text x={(L + W - R) / 2} y={H - 1} textAnchor="middle">confidence in what we found</text>
							<text transform={`translate(10 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">impact on decision</text>
							{plotted.map((t) => (
								<g key={t.id} className="pt" transform={`translate(${x(t.confidence!)} ${y(imp(t))})`}>
									<circle r="6" fill={t.state === "research_incomplete" ? "var(--bg)" : "var(--ink)"} stroke={t.state === "research_incomplete" ? "var(--warn)" : "var(--bg)"} strokeWidth="2" />
									<text x="10" y="4">{short(t.title)}</text>
									<title>{`${t.title}: impact ${imp(t)}, confidence ${t.confidence}, ${label(t.state)}`}</title>
								</g>
							))}
						</svg>
					</Figure>
					<h3 className="sub">All topics</h3>
					<table>
						<thead><tr><th>Topic</th><th>State</th><th className="r">Impact</th><th className="r">Confidence</th><th className="r">Priority</th><th className="r">Agents</th></tr></thead>
						<tbody>
							{[...topics].sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state)).map((t) => (
								<tr key={t.id}>
									<td><span className="asof">{t.id}</span> {t.title}{t.state_reason && <div className="flip">{t.state_reason}</div>}</td>
									<td><Chip kind={t.state} /></td>
									<td className="num">{t.state === "dropped" ? "—" : imp(t).toFixed(2)}</td>
									<td className="num">{t.confidence !== undefined ? pct(t.confidence) : "—"}</td>
									<td className="num">{t.priority !== undefined ? t.priority.toFixed(2) : "—"}</td>
									<td className="num">{t.assigned_agents?.length ?? 0}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</Section>
	)
}
