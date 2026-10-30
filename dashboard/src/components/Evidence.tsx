import { useEffect, useMemo, useRef, useState } from "react"
import type { Assumption, BusinessPlan, Finding, Scenario, Source } from "../types/contracts.ts"
import { effective } from "../derive.ts"
import { confWord, dateOnly, pct } from "../fmt.ts"
import { Chip, Section } from "../ui.tsx"

const ROW = 84
const VIEW = 440

function FindingRow({ f, sources, top, hl }: { f: Finding; sources: Map<string, Source>; top: number; hl: boolean }) {
	const srcs = f.source_ids.map((id) => sources.get(id)).filter(Boolean) as Source[]
	return (
		<div className={`row-f${hl ? " hl" : ""}`} style={{ top }} id={`finding-${f.id}`}>
			<p>{f.claim}</p>
			<div className="meta">
				<span className="asof">{f.id}</span>
				<span>{f.type}</span>
				<span>conf. {pct(f.confidence)} ({confWord(f.confidence)})</span>
				<span className="asof">as of {dateOnly(f.as_of)}</span>
				{f.verified ? <Chip kind="ok">verified</Chip> : <Chip kind="queued">unverified</Chip>}
				{f.stale && <Chip kind="stale">stale</Chip>}
				{(f.conflicts_with?.length ?? 0) > 0 && <Chip kind="flag">conflicts with {f.conflicts_with!.join(", ")}</Chip>}
				{srcs.map((s) => (
					<span key={s.id}>
						{s.injection_flagged ? <Chip kind="flag">injection flagged</Chip> : null}{" "}
						<a href={s.url} target="_blank" rel="noreferrer noopener" style={{ color: "var(--accent)" }}>{s.publisher ?? s.title ?? s.url}</a>
					</span>
				))}
			</div>
		</div>
	)
}

function Why({ plan, rec, findings, scenarios, assumptions }: { plan: BusinessPlan; rec: BusinessPlan["recommendations"][number]; findings: Map<string, Finding>; scenarios: Scenario[]; assumptions: Assumption[] }) {
	const sc = scenarios.filter((s) => rec.scenario_ids?.includes(s.id))
	const as = assumptions.filter((a) => sc.some((s) => s.assumption_ids.includes(a.id)) || plan.assumption_ids.includes(a.id))
	return (
		<div className="why">
			<strong>Evidence behind this</strong>
			<ul>
				{rec.finding_ids.length === 0 && <li>No findings cited. Treat this as judgement.</li>}
				{rec.finding_ids.map((id) => <li key={id}>{findings.get(id)?.claim ?? `${id} (not found)`} <span className="asof">{id}</span></li>)}
			</ul>
			<strong style={{ display: "block", marginTop: 10 }}>Assumptions it depends on</strong>
			<ul>{as.map((a) => <li key={a.id}>{a.text}: <span className="num">{effective(a)}</span> {a.unit} ({a.low}–{a.high})</li>)}</ul>
		</div>
	)
}

export function Evidence({ plan, findings, sources, scenarios, assumptions, focus }: { plan?: BusinessPlan; findings: Finding[]; sources: Source[]; scenarios: Scenario[]; assumptions: Assumption[]; focus: string[] }) {
	const [open, setOpen] = useState<number | null>(null)
	const [q, setQ] = useState("")
	const [only, setOnly] = useState<"all" | "conflict" | "stale" | "unverified">("all")
	const [scroll, setScroll] = useState(0)
	const box = useRef<HTMLDivElement>(null)
	const byId = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings])
	const srcById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources])
	const shown = useMemo(
		() => findings.filter((f) => (only === "all" || (only === "conflict" ? (f.conflicts_with?.length ?? 0) > 0 : only === "stale" ? f.stale : !f.verified)) && (!q || f.claim.toLowerCase().includes(q.toLowerCase()))),
		[findings, q, only],
	)
	useEffect(() => {
		const i = shown.findIndex((f) => focus.includes(f.id))
		if (i >= 0 && box.current) box.current.scrollTo({ top: i * ROW - 8 })
	}, [focus, shown])
	const first = Math.max(0, Math.floor(scroll / ROW) - 3)
	const last = Math.min(shown.length, Math.ceil((scroll + VIEW) / ROW) + 3)
	const flagged = sources.filter((s) => s.injection_flagged)
	return (
		<Section id="evidence" n="08" title="Evidence" lede="Every recommendation links to the findings and assumptions behind it. Open “Why this?” to see them.">
			{plan && (
				<ol className="recs">
					{plan.recommendations.map((r, i) => (
						<li key={r.rank} className="rec">
							<span className="n">{r.rank}</span>
							<div>
								<h3>{r.title} <span className="asof">confidence {pct(r.confidence)}</span></h3>
								<p>{r.rationale}</p>
								{r.what_would_change_this && <p className="note">Would change if: {r.what_would_change_this}</p>}
								<button className="btn link" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>Why this?</button>
								{open === i && <Why plan={plan} rec={r} findings={byId} scenarios={scenarios} assumptions={assumptions} />}
							</div>
						</li>
					))}
				</ol>
			)}
			{flagged.length > 0 && <p className="banner crit" role="alert"><b>{flagged.length} source{flagged.length > 1 ? "s" : ""} flagged for prompt injection</b>Their text was treated as data and is excluded from agent instructions.</p>}
			<h3 className="sub" style={{ marginTop: 24 }}>Findings ({shown.length}{shown.length !== findings.length ? ` of ${findings.length}` : ""})</h3>
			<div className="filters">
				<input type="search" placeholder="Search claims" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search claims" />
				{(["all", "conflict", "stale", "unverified"] as const).map((k) => <button key={k} className="btn" aria-pressed={only === k} style={only === k ? { borderColor: "var(--ink)" } : undefined} onClick={() => setOnly(k)}>{k}</button>)}
			</div>
			{shown.length === 0 ? <p className="note">{findings.length ? "Nothing matches." : "No findings yet."}</p> : (
				<div className="vlist" ref={box} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} tabIndex={0} aria-label="Findings list">
					<div style={{ height: shown.length * ROW, position: "relative" }}>
						{shown.slice(first, last).map((f, i) => <FindingRow key={f.id} f={f} sources={srcById} top={(first + i) * ROW} hl={focus.includes(f.id)} />)}
					</div>
				</div>
			)}
		</Section>
	)
}
