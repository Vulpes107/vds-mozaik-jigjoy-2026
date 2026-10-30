import type { BusinessPlan } from "../types/contracts.ts"
import { Section } from "../ui.tsx"

export function Roadmap({ plan }: { plan?: BusinessPlan }) {
	const items = [...(plan?.roadmap ?? [])].sort((a, b) => a.month - b.month)
	return (
		<Section id="roadmap" n="07" title="Roadmap" lede="Money is released in steps. At each gate, if a stop condition is met, the next step does not go ahead.">
			{items.length === 0 ? <p className="note">No roadmap yet.</p> : (
				<ol className="road">
					{items.map((m, i) => (
						<li key={i} className={m.gate ? "gate" : ""}>
							<span className="mo">Month {m.month}</span>
							<span className="node" aria-hidden="true" />
							<div>
								<strong>{m.milestone}</strong>{m.gate && <span className="asof"> · gate</span>}
								{m.kill_criteria?.map((k) => <div key={k} className="kill">{k}</div>)}
							</div>
						</li>
					))}
				</ol>
			)}
		</Section>
	)
}
