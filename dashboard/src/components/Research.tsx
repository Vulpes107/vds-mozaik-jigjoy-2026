import type { Topic } from "../types/contracts.ts"
import { mapStory } from "../derive.ts"
import { label, pct } from "../fmt.ts"
import { Chip, Figure, Section } from "../ui.tsx"

const STATES: Topic["state"][] = ["research_incomplete", "queued", "scouting", "deep", "shallow", "closed", "dropped"]
const short = (s: string) => (s.length > 26 ? `${s.slice(0, 25)}…` : s)

/** Greedy label placement: try right, left, above, below; take the first spot that hits no dot and no earlier label. */
interface Pt { t: Topic; x: number; y: number; unscored: boolean }
function placeLabels(pts: Pt[], text: (t: Topic) => string, bounds: { l: number; r: number; t: number; b: number }) {
	const boxes: { x0: number; x1: number; y0: number; y1: number }[] = []
	const hit = (a: (typeof boxes)[number], c: (typeof boxes)[number]) => a.x0 < c.x1 && a.x1 > c.x0 && a.y0 < c.y1 && a.y1 > c.y0
	const dots = pts.map((p) => ({ x0: p.x - 8, x1: p.x + 8, y0: p.y - 8, y1: p.y + 8 }))
	const out = new Map<string, { x: number; y: number; anchor: "start" | "end" | "middle"; text: string }>()
	for (const p of [...pts].sort((a, b) => a.y - b.y)) {
		const label = text(p.t)
		const w = label.length * 6.8
		const cands = [
			{ x: p.x + 11, y: p.y + 4, anchor: "start" as const, box: { x0: p.x + 10, x1: p.x + 10 + w, y0: p.y - 8, y1: p.y + 8 } },
			{ x: p.x - 11, y: p.y + 4, anchor: "end" as const, box: { x0: p.x - 10 - w, x1: p.x - 10, y0: p.y - 8, y1: p.y + 8 } },
			{ x: p.x, y: p.y - 12, anchor: "middle" as const, box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - 24, y1: p.y - 9 } },
			{ x: p.x, y: p.y + 22, anchor: "middle" as const, box: { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y + 9, y1: p.y + 24 } },
		]
		const ok = cands.find((c) => c.box.x0 >= bounds.l && c.box.x1 <= bounds.r && c.box.y0 >= bounds.t && c.box.y1 <= bounds.b && !boxes.some((b) => hit(b, c.box)) && !dots.some((d) => hit(d, c.box)))
		const pick = ok ?? cands[0]!
		boxes.push(pick.box)
		out.set(p.t.id, { x: pick.x, y: pick.y, anchor: pick.anchor, text: label })
	}
	return out
}

export function Research({ topics }: { topics: Topic[] }) {
	const W = 600, H = 340, L = 56, B = 40, T = 30, R = 24
	const live = topics.filter((t) => t.state !== "dropped")
	const imp = (t: Topic) => t.impact ?? t.importance_prior
	const x = (c: number) => L + c * (W - L - R)
	const y = (i: number) => T + (1 - i) * (H - T - B)
	const pts: Pt[] = live.map((t) => ({ t, x: x(t.confidence ?? 0), y: y(imp(t)), unscored: t.confidence === undefined }))
	const dense = pts.length > 6
	const labels = placeLabels(pts, (t) => (dense ? t.id : `${t.id} ${t.title.length > 22 ? `${t.title.slice(0, 21)}…` : t.title}`), { l: 4, r: W - 4, t: T - 4, b: H - B })
	const unscored = pts.filter((p) => p.unscored).length
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
							"A dashed hollow dot sits on the left edge: the topic has no confidence score yet. A hollow amber dot means the research could not be finished. Dropped topics are not plotted.",
						]}
						now={mapStory(topics)}
					>
						<svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Topics by impact and confidence">
							<rect x={L} y={T} width={(W - L - R) / 2} height={(H - T - B) / 2} fill="var(--warn-bg)" opacity="0.75" />
							<text x={L} y={T - 10} style={{ fill: "var(--warn)" }}>Shaded: matters, but weakly evidenced</text>
							<line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--ink)" />
							<line x1={L} x2={L} y1={T} y2={y(0)} stroke="var(--ink)" />
							{[0, 0.5, 1].map((v) => (
								<g key={v}>
									<text x={x(v)} y={H - B + 16} textAnchor="middle">{v}</text>
									<text x={L - 14} y={y(v) + 4} textAnchor="end">{v}</text>
								</g>
							))}
							<text x={(L + W - R) / 2} y={H - 4} textAnchor="middle">confidence in what we found</text>
							<text transform={`translate(12 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle">impact on decision</text>
							{pts.map(({ t, x: cx, y: cy, unscored: u }) => {
								const l = labels.get(t.id)!
								const open = u || t.state === "research_incomplete"
								return (
									<g key={t.id} className="pt">
										<circle cx={cx} cy={cy} r="6" fill={open ? "var(--bg)" : "var(--ink)"} stroke={t.state === "research_incomplete" ? "var(--warn)" : open ? "var(--ink)" : "var(--bg)"} strokeWidth="2" strokeDasharray={u ? "2 2" : undefined} />
										<text x={l.x} y={l.y} textAnchor={l.anchor}>{l.text}</text>
										<title>{`${t.title}: impact ${imp(t)}, ${u ? "not scored yet" : `confidence ${t.confidence}`}, ${label(t.state)}`}</title>
									</g>
								)
							})}
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
