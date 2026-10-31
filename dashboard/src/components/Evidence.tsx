import { useEffect, useMemo, useRef, useState } from "react"
import type { Finding, Source } from "../types/contracts.ts"
import { sourceStats } from "../derive.ts"
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

export function Evidence({ findings, sources, focus }: { findings: Finding[]; sources: Source[]; focus: string[] }) {
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
	const stats = sourceStats(sources)
	return (
		<Section id="evidence" title="The evidence" lede="Every claim the agents collected and where it came from. Click “findings” on an assumption, or “Why this?” on a recommendation, to jump to the evidence behind it.">
			<div className="cols-8-4">
				<div>
					<h3 className="sub">Findings ({shown.length}{shown.length !== findings.length ? ` of ${findings.length}` : ""})</h3>
					<div className="filters">
						<input type="search" placeholder="Search claims" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search claims" />
						{(["all", "conflict", "stale", "unverified"] as const).map((kk) => <button key={kk} className="btn" aria-pressed={only === kk} style={only === kk ? { borderColor: "var(--ink)" } : undefined} onClick={() => setOnly(kk)}>{kk}</button>)}
					</div>
					{shown.length === 0 ? <p className="note">{findings.length ? "Nothing matches." : "No findings yet."}</p> : (
						<div className="vlist" style={{ height: Math.min(VIEW, shown.length * ROW + 2) }} ref={box} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} tabIndex={0} aria-label="Findings list">
							<div style={{ height: shown.length * ROW, position: "relative" }}>
								{shown.slice(first, last).map((f, i) => <FindingRow key={f.id} f={f} sources={srcById} top={(first + i) * ROW} hl={focus.includes(f.id)} />)}
							</div>
						</div>
					)}
				</div>
				<div>
					<h3 className="sub">Source check</h3>
					<ul className="facts">
						<li><b className="num">{stats.n}</b> sources used</li>
						<li><b className="num">{pct(stats.avg)}</b> average reliability</li>
						<li><b className="num">{stats.weak}</b> below 50% reliability</li>
						<li className={stats.flagged ? "bad" : ""}><b className="num">{stats.flagged}</b> flagged for prompt injection</li>
						<li><b className="num">{findings.filter((f) => (f.conflicts_with?.length ?? 0) > 0).length}</b> findings in conflict</li>
						<li><b className="num">{findings.filter((f) => f.stale).length}</b> stale findings</li>
					</ul>
					{stats.flagged > 0 && <p className="banner crit" role="alert"><b>Injection attempt</b>Flagged text was treated as data only and never used as instructions.</p>}
					<ul className="srcs">
						{[...sources].sort((a, b) => b.reliability - a.reliability).map((s) => (
							<li key={s.id}>
								<a href={s.url} target="_blank" rel="noreferrer noopener">{s.title ?? s.publisher ?? s.url}</a>
								<span className="meta"><span className="asof">{s.id}</span> {s.source_type ?? "source"} {s.injection_flagged && <Chip kind="flag">flagged</Chip>}</span>
								<span className="bar" role="meter" aria-label="Reliability" aria-valuenow={Math.round(s.reliability * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${s.reliability * 100}%` }} /></span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</Section>
	)
}
