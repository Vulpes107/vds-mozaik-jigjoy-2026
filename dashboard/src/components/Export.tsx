import { useState } from "react"
import { RUN_ID } from "../api.ts"
import { toMarkdown } from "../derive.ts"
import type { Assumption, BusinessPlan, Finding, Scenario } from "../types/contracts.ts"
import { Section } from "../ui.tsx"

function save(name: string, text: string, type: string) {
	const a = document.createElement("a")
	a.href = URL.createObjectURL(new Blob([text], { type }))
	a.download = name
	a.click()
	URL.revokeObjectURL(a.href)
}

export function Export({ plan, scenarios, assumptions, findings }: { plan?: BusinessPlan; scenarios: Scenario[]; assumptions: Assumption[]; findings: Finding[] }) {
	const [copied, setCopied] = useState(false)
	const share = `${location.origin}${location.pathname}?run=${RUN_ID}&ro=1`
	return (
		<Section id="export" n="09" title="Export" lede="Take the plan with you. The share link opens this page without editing controls.">
			<div className="filters">
				<button className="btn" disabled={!plan} onClick={() => plan && save(`${RUN_ID}.json`, JSON.stringify({ plan, scenarios, assumptions, findings }, null, 2), "application/json")}>JSON</button>
				<button className="btn" disabled={!plan} onClick={() => plan && save(`${RUN_ID}.md`, toMarkdown(plan, scenarios, assumptions), "text/markdown")}>Markdown</button>
				<button className="btn" onClick={() => window.print()}>PDF (print)</button>
				<button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(share); setCopied(true) } catch { prompt("Copy link", share) } }}>{copied ? "Link copied" : "Copy read-only link"}</button>
			</div>
			<p className="note">The link works for anyone who can reach this dashboard's API; it adds no authentication.</p>
			{plan && <p className="foot">{plan.disclaimer}</p>}
		</Section>
	)
}
