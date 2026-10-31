import { useState } from "react"
import { API, READ_ONLY, RUN_ID, useRun } from "./api.ts"
import { Activity } from "./components/Activity.tsx"
import { Evidence } from "./components/Evidence.tsx"
import { Export } from "./components/Export.tsx"
import { Financials } from "./components/Financials.tsx"
import { Header } from "./components/Header.tsx"
import { Recommendation } from "./components/Recommendation.tsx"
import { Research } from "./components/Research.tsx"
import { Risks } from "./components/Risks.tsx"
import { Verdict } from "./components/Verdict.tsx"
import { LOW_CONFIDENCE } from "./derive.ts"
import { Banner } from "./ui.tsx"

export function App() {
	const { data, overrideAssumption, resolveCheckpoint, reload } = useRun()
	const [focus, setFocus] = useState<string[]>([])
	const { run, plan, conn } = data

	if (!run) {
		return (
			<main className="empty">
				{conn === "loading" ? (
					<>
						<h1>Loading run {RUN_ID}</h1>
						<div className="skeleton" /><div className="skeleton" style={{ maxWidth: "40%" }} />
					</>
				) : (
					<>
						<h1>No run to show</h1>
						<p className="lede">Could not reach the API at <code>{API}</code>{data.error ? ` (${data.error})` : ""}. Start the mock server and reload:</p>
						<pre>npm run mock{"\n"}npm run dev</pre>
						<p style={{ marginTop: 16 }}><button className="btn primary" onClick={() => void reload()}>Try again</button></p>
					</>
				)}
			</main>
		)
	}

	const pending = (run.checkpoints ?? []).filter((c) => c.status === "pending")
	const soft = plan?.overall_confidence !== undefined && plan.overall_confidence < LOW_CONFIDENCE
	const failed = run.status === "failed"
	const partial = plan && ((plan.unresolved_topic_ids?.length ?? 0) > 0 || run.status === "budget_exhausted")

	// Reading order follows the reader's questions: what should I do -> can I afford it -> what can go wrong ->
	// how sure are we -> who did the work -> proof. While the run is still going there is no plan, so live work leads.
	const activity = <Activity key="activity" events={data.events} topics={data.topics} />
	const research = <Research key="research" topics={data.topics} />
	const nav = plan
		? [["recommend", "Recommendation"], ["finance", "Finances"], ["risks", "Risks"], ["research", "Research"], ["activity", "Agents"], ["evidence", "Evidence"], ["export", "Export"]]
		: [["activity", "Agents"], ["research", "Research"], ["evidence", "Evidence"], ["export", "Export"]]

	return (
		<main className={`page${soft ? " soft" : ""}`}>
			<Header run={run} conn={conn} />
			<nav className="nav" aria-label="Sections">
				{nav.map(([id, name]) => <a key={id} href={`#${id}`}>{name}</a>)}
			</nav>
			{conn === "reconnecting" && <Banner kind="warn" title="Connection lost">Showing the last data received. Reconnecting; missed events are replayed automatically.</Banner>}
			{failed && <Banner kind="crit" title="Run failed">The run stopped before a plan could be produced. Partial research below is still valid.</Banner>}
			{pending.map((c) => (
				<Banner key={c.id} kind="info" title="Your approval is needed">
					<p>The swarm is waiting for you to approve the {c.kind === "topics" ? "list of research topics and the budget" : c.kind} before it spends anything.</p>
					{!READ_ONLY && (
						<div className="row">
							<button className="btn primary" onClick={() => void resolveCheckpoint(c.id, true)}>Approve</button>
							<button className="btn" onClick={() => void resolveCheckpoint(c.id, false)}>Reject</button>
						</div>
					)}
				</Banner>
			))}
			<Verdict plan={plan} scenarios={data.scenarios} topics={data.topics} assumptions={data.assumptions} findings={data.findings} sources={data.sources} />
			{partial && <Banner kind="warn" title="Partial plan">{plan?.unresolved_topic_ids?.length ?? 0} topic(s) could not be completed, so conclusions that depend on them are less certain.</Banner>}
			{soft && <Banner kind="warn" title="Low-confidence run">Treat the figures below as rough orientation, not a basis for committing money. The reasons are listed next to the confidence score.</Banner>}
			{!plan && <>{activity}{research}</>}
			{plan && (
				<>
					<Recommendation plan={plan} scenarios={data.scenarios} findings={data.findings} assumptions={data.assumptions} />
					<Financials scenarios={data.scenarios} assumptions={data.assumptions} opening={run.profile?.financials?.cash_on_hand} onOverride={(id, v) => void overrideAssumption(id, v)} onFocusFindings={(ids) => { setFocus(ids); document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth" }) }} />
					<Risks plan={plan} />
					{research}
					{activity}
				</>
			)}
			<Evidence findings={data.findings} sources={data.sources} focus={focus} />
			<Export plan={plan} scenarios={data.scenarios} assumptions={data.assumptions} findings={data.findings} />
		</main>
	)
}
