import { useEffect, useState } from "react"
import { listRuns, type RunRow } from "../api.ts"
import { label } from "../fmt.ts"
import { Chip } from "../ui.tsx"

/** Previous runs from `GET /runs`, newest first; each opens read-only (or live, if the server still hosts it). */
export function RunList() {
	const [runs, setRuns] = useState<RunRow[]>()
	const [err, setErr] = useState<string>()
	useEffect(() => {
		listRuns().then(setRuns, (e: Error) => setErr(e.message))
	}, [])
	return (
		<>
			<h2>Previous runs</h2>
			{err && <p className="note" role="status">Could not list runs: {err}. Is the orchestrator running?</p>}
			{runs && runs.length === 0 && <p className="note">None yet. The first run you start appears here.</p>}
			{runs && runs.length > 0 && (
				<ul className="runs">
					{runs.map((r) => (
						<li key={r.run_id}>
							<a href={`?run=${r.run_id}`}>
								<b>{r.company ?? r.run_id}</b>
								<span className="meta">
									<Chip kind={r.status === "done" ? "closed" : r.status === "failed" || r.status === "stopped" ? "flag" : "deep"}>{label(r.status)}</Chip>
									<span>{r.saved_at.slice(0, 16).replace("T", " ")} UTC</span>
									<span>{r.spent_usd.toFixed(2)} USD</span>
								</span>
							</a>
						</li>
					))}
				</ul>
			)}
		</>
	)
}
