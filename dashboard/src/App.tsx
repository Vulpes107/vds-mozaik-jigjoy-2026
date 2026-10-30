import { useState } from "react"
import sample from "../../mocks/company_profile.sample.json"
import { API, READ_ONLY, RUN_ID, startRun, useRun } from "./api.ts"
import { Activity } from "./components/Activity.tsx"
import { Decision } from "./components/Decision.tsx"
import { Evidence } from "./components/Evidence.tsx"
import { Export } from "./components/Export.tsx"
import { Financials } from "./components/Financials.tsx"
import { Header } from "./components/Header.tsx"
import { Research } from "./components/Research.tsx"
import { Risks } from "./components/Risks.tsx"
import { Roadmap } from "./components/Roadmap.tsx"
import { Verdict } from "./components/Verdict.tsx"
import { LOW_CONFIDENCE } from "./derive.ts"
import { Banner } from "./ui.tsx"

export function App() {
	const { data, overrideAssumption, resolveCheckpoint, reload } = useRun()
	const [focus, setFocus] = useState<string[]>([])
	const { run, plan, conn } = data

	if (!run) return <Empty conn={conn} error={data.error} reload={reload} />

	const pending = (run.checkpoints ?? []).filter((c) => c.status === "pending")
	const soft = plan?.overall_confidence !== undefined && plan.overall_confidence < LOW_CONFIDENCE
	const failed = run.status === "failed"
	const partial = plan && ((plan.unresolved_topic_ids?.length ?? 0) > 0 || run.status === "budget_exhausted")

	return (
		<main className={`page${soft ? " soft" : ""}`}>
			<Header run={run} conn={conn} />
			{conn === "reconnecting" && <Banner kind="warn" title="Connection lost">Showing the last data received. Reconnecting; missed events are replayed automatically.</Banner>}
			{failed && <Banner kind="crit" title="Run failed">The run stopped before a plan could be produced. Partial research below is still valid.</Banner>}
			{pending.map((c) => (
				<Banner key={c.id} kind="info" title="Your approval is needed">
					<p>The swarm is waiting for you to approve the {c.kind === "topics" || c.kind === "approve_topics" ? "list of research topics and the budget" : c.kind} before it spends anything.</p>
					{!READ_ONLY && (
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
			<Financials scenarios={data.scenarios} assumptions={data.assumptions} opening={run.profile?.financials?.cash_on_hand} onOverride={(id, v) => void overrideAssumption(id, v)} onFocusFindings={(ids) => { setFocus(ids); document.getElementById("evidence")?.scrollIntoView({ behavior: "smooth" }) }} />
			<Research topics={data.topics} />
			<Activity events={data.events} topics={data.topics} />
			<Risks plan={plan} />
			<Roadmap plan={plan} />
			<Evidence plan={plan} findings={data.findings} sources={data.sources} scenarios={data.scenarios} assumptions={data.assumptions} focus={focus} />
			<Export plan={plan} scenarios={data.scenarios} assumptions={data.assumptions} findings={data.findings} />
		</main>
	)
}

/** No run loaded: offline, or the server hosts none yet. Intake = a CompanyProfile, prefilled from the golden fixture. */
function Empty({ conn, error, reload }: { conn: string; error?: string; reload: () => Promise<void> }) {
	const [profile, setProfile] = useState(() => JSON.stringify(sample, null, 2))
	const [err, setErr] = useState<string>()
	const [busy, setBusy] = useState(false)
	if (conn === "loading") {
		return (
			<main className="empty">
				<h1>Loading run {RUN_ID}</h1>
				<div className="skeleton" /><div className="skeleton" style={{ maxWidth: "40%" }} />
			</main>
		)
	}
	const start = async () => {
		setBusy(true)
		setErr(undefined)
		try {
			const id = await startRun(JSON.parse(profile))
			location.search = `?run=${id}` // reload on the new run
		} catch (e) {
			setErr((e as Error).message)
			setBusy(false)
		}
	}
	return (
		<main className="empty">
			<h1>No run to show</h1>
			<p className="lede">API <code>{API || location.origin}</code>{error ? `: ${error}` : ""}. Start the orchestrator (or the mock) and retry, or start a new run from a company profile.</p>
			<pre>node --env-file=.env --import tsx src/orchestrator/server.ts{"\n"}npm run dev</pre>
			{!READ_ONLY && (
				<>
					<label htmlFor="profile" className="lede" style={{ display: "block", marginTop: 24 }}>Company profile (JSON)</label>
					<textarea id="profile" value={profile} onChange={(e) => setProfile(e.target.value)} rows={14} spellCheck={false} style={{ width: "100%", font: "13px/1.5 var(--mono)" }} />
					{err && <p className="lede" role="alert">{err}</p>}
				</>
			)}
			<p className="row" style={{ marginTop: 16 }}>
				{!READ_ONLY && <button className="btn primary" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start run"}</button>}
				<button className="btn" onClick={() => void reload()}>Try again</button>
			</p>
		</main>
	)
}
