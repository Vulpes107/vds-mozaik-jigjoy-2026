import { useState } from "react"
import { API, READ_ONLY, RUN_ID, useRun } from "./api.ts"
import { Activity } from "./components/Activity.tsx"
import { Decision } from "./components/Decision.tsx"
import { Evidence } from "./components/Evidence.tsx"
import { Export } from "./components/Export.tsx"
import { Financials } from "./components/Financials.tsx"
import { Header } from "./components/Header.tsx"
import { Intake } from "./components/Intake.tsx"
import { RunList } from "./components/RunList.tsx"
import { Research } from "./components/Research.tsx"
import { Risks } from "./components/Risks.tsx"
import { Roadmap } from "./components/Roadmap.tsx"
import { Verdict } from "./components/Verdict.tsx"
import { LOW_CONFIDENCE } from "./derive.ts"
import { Banner } from "./ui.tsx"

/** `/` is the landing page (intake form + previous runs); `?run=<id>` opens one run. */
export const App = () => (RUN_ID ? <RunPage /> : <Landing />)

function Landing() {
	return (
		<main className="landing">
			<div>
				<div className="brand">Strategy Swarm</div>
				<h1>New research run</h1>
				<p className="lede">Describe the company and set the limits. The swarm plans topics, asks for your approval, researches, and costs a plan.</p>
				{READ_ONLY ? <p className="note">Read-only view: starting runs is disabled.</p> : <Intake />}
			</div>
			<aside>
				<RunList />
			</aside>
		</main>
	)
}

function RunPage() {
	const { data, overrideAssumption, resolveCheckpoint, reload } = useRun()
	const [focus, setFocus] = useState<string[]>([])
	const { run, plan, conn } = data

	if (!run) return <Empty conn={conn} error={data.error} reload={reload} />
	const ro = READ_ONLY || run.live === false

	const pending = (run.checkpoints ?? []).filter((c) => c.status === "pending")
	const soft = plan?.overall_confidence !== undefined && plan.overall_confidence < LOW_CONFIDENCE
	const failed = run.status === "failed"
	const stopped = run.status === "stopped"
	const stopReason = data.events.find((e) => e.type === "run_completed")?.detail
	const partial = plan && ((plan.unresolved_topic_ids?.length ?? 0) > 0 || run.status === "budget_exhausted")

	return (
		<main className={`page${soft ? " soft" : ""}`}>
			<Header run={run} conn={conn} />
			{conn === "reconnecting" && <Banner kind="warn" title="Connection lost">Showing the last data received. Reconnecting; missed events are replayed automatically.</Banner>}
			{failed && <Banner kind="crit" title="Run failed">The run stopped before a plan could be produced. Partial research below is still valid.</Banner>}
			{stopped && !plan && (
				<Banner kind="warn" title="Run stopped">
					This run ended before a plan was produced. The research below is what it had found.
					{stopReason && <pre className="reason">{stopReason}</pre>}
				</Banner>
			)}
			{pending.map((c) => (
				<Banner key={c.id} kind="info" title="Your approval is needed">
					<p>The swarm is waiting for you to approve the {c.kind === "topics" || c.kind === "approve_topics" ? "list of research topics and the budget" : c.kind} before it spends anything.</p>
					{!ro && (
						<div className="row">
							<button className="btn primary" onClick={() => void resolveCheckpoint(c.id, true)}>Approve</button>
							<button className="btn" onClick={() => void resolveCheckpoint(c.id, false)}>Reject</button>
						</div>
					)}
				</Banner>
			))}
			<Verdict plan={plan} scenarios={data.scenarios} topics={data.topics} assumptions={data.assumptions} findings={data.findings} />
			{partial && <Banner kind="warn" title="Partial plan">{plan?.unresolved_topic_ids?.length ?? 0} topic(s) could not be completed, so conclusions that depend on them are less certain.</Banner>}
			{soft && <Banner kind="warn" title="Low-confidence run">Treat the figures below as a rough orientation, not a basis for committing money. The reasons are listed next to the confidence score.</Banner>}
			<Decision plan={plan} scenarios={data.scenarios} />
			<Financials scenarios={data.scenarios} assumptions={data.assumptions} opening={run.profile?.financials?.cash_on_hand} onOverride={(id, v) => void overrideAssumption(id, v)} readOnly={ro} onFocusFindings={(ids) => { setFocus(ids); document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth" }) }} />
			<Research topics={data.topics} />
			<Activity events={data.events} topics={data.topics} />
			<Risks plan={plan} />
			<Roadmap plan={plan} />
			<Evidence plan={plan} findings={data.findings} sources={data.sources} scenarios={data.scenarios} assumptions={data.assumptions} focus={focus} />
			<Export plan={plan} scenarios={data.scenarios} assumptions={data.assumptions} findings={data.findings} />
		</main>
	)
}

/** The run could not be loaded: offline, or the server does not know that id. */
function Empty({ conn, error, reload }: { conn: string; error?: string; reload: () => Promise<void> }) {
	if (conn === "loading") {
		return (
			<main className="empty">
				<h1>Loading run {RUN_ID}</h1>
				<div className="skeleton" /><div className="skeleton" style={{ maxWidth: "40%" }} />
			</main>
		)
	}
	return (
		<main className="empty">
			<h1>No run to show</h1>
			<p className="lede">API <code>{API || location.origin}</code>{error ? `: ${error}` : ""}. Start the orchestrator (or the mock) and retry, or go back and start a new run.</p>
			<pre>node --env-file=.env --import tsx src/orchestrator/server.ts{"\n"}npm run dev</pre>
			<p className="row" style={{ marginTop: 16 }}>
				<button className="btn" onClick={() => void reload()}>Try again</button>
				<a className="btn primary" href={location.pathname}>New run</a>
			</p>
		</main>
	)
}
