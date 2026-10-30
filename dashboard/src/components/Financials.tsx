import { useEffect, useMemo, useRef, useState } from "react"
import type { Assumption, Scenario } from "../types/contracts.ts"
import { READ_ONLY } from "../api.ts"
import { cashCurve, effective, firstBelowZero, groupScenarios, isPinned } from "../derive.ts"
import { compact, money, pct } from "../fmt.ts"
import { Chip, RangeBar, Section } from "../ui.tsx"

const SERIES = ["var(--c-scout)", "var(--c-collector)", "var(--c-analyst)", "var(--c-verifier)", "var(--c-other)"]

function Scenarios({ scenarios }: { scenarios: Scenario[] }) {
	const groups = groupScenarios(scenarios)
	const npvs = groups.flatMap((g) => [g.low, g.base, g.high].map((s) => s?.metrics?.npv).filter((x): x is number => x !== undefined))
	const min = Math.min(0, ...npvs) * 1.15
	const max = Math.max(0, ...npvs) * 1.15 || 1
	return (
		<>
			<h3 className="sub">Net present value by scenario</h3>
			<ul className="rank" style={{ listStyle: "none", padding: 0 }}>
				{groups.map((g) => (
					<li key={g.kind} style={{ gridTemplateColumns: "110px 1fr", alignItems: "start", paddingBottom: 22 }}>
						<span>
							{g.name}
							{g.base.metrics?.runway_breached && <div><Chip kind="flag">Runway breached</Chip></div>}
						</span>
						<RangeBar min={min} max={max} low={g.low?.metrics?.npv} base={g.base.metrics?.npv ?? 0} high={g.high?.metrics?.npv} fmt={compact} ariaLabel={`${g.name} NPV`} />
					</li>
				))}
			</ul>
			<p className="note">{groups.some((g) => g.low) ? "Band = adverse to favourable case." : "Only the base case was computed; no range is available yet."} Currency {scenarios[0]?.currency}.</p>
			<table style={{ marginTop: 14 }}>
				<thead><tr><th>Scenario</th><th className="r">NPV</th><th className="r">IRR</th><th className="r">Payback</th><th className="r">Break-even</th><th className="r">Min cash</th></tr></thead>
				<tbody>
					{groups.map((g) => {
						const m = g.base.metrics
						return (
							<tr key={g.kind}>
								<td>{g.name}</td>
								<td className="num">{m?.npv !== undefined ? compact(m.npv) : "—"}</td>
								<td className="num">{m?.irr != null ? pct(m.irr) : "n/a"}</td>
								<td className="num">{m?.payback_months != null ? `${m.payback_months} mo` : "n/a"}</td>
								<td className="num">{m?.break_even_month != null ? `mo ${m.break_even_month}` : "n/a"}</td>
								<td className="num">{m?.min_cash_balance !== undefined ? compact(m.min_cash_balance) : "—"}</td>
							</tr>
						)
					})}
				</tbody>
			</table>
		</>
	)
}

function CashChart({ scenarios, opening }: { scenarios: Scenario[]; opening: number | undefined }) {
	const base = scenarios.filter((s) => (s.case ?? "base") === "base")
	const curves = useMemo(() => base.map((s) => ({ s, pts: cashCurve(s, opening ?? 0) })), [base, opening])
	if (!curves.length) return null
	const W = 560, H = 260, L = 52, R = 96, T = 14, B = 28
	const months = Math.max(...curves.map((c) => c.pts.length - 1))
	const all = curves.flatMap((c) => c.pts.map((p) => p.cash))
	const lo = Math.min(0, ...all), hi = Math.max(0, ...all)
	const x = (m: number) => L + (m / months) * (W - L - R)
	const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B)
	return (
		<>
			<h3 className="sub">Cumulative cash{opening === undefined ? " (relative to start)" : ""}</h3>
			<svg className="cash" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cumulative cash by scenario, with the zero line">
				<line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--ink)" strokeWidth="1" />
				<text x={L - 6} y={y(0) + 4} textAnchor="end">0</text>
				<text x={L - 6} y={y(hi) + 4} textAnchor="end">{compact(hi)}</text>
				{lo < 0 && <text x={L - 6} y={y(lo) + 4} textAnchor="end">{compact(lo)}</text>}
				{Array.from({ length: Math.floor(months / 12) + 1 }, (_, i) => (
					<text key={i} x={x(i * 12)} y={H - 8} textAnchor="middle">{i === 0 ? "start" : `y${i}`}</text>
				))}
				{curves.map(({ s, pts }, i) => {
					const d = pts.map((p, k) => `${k ? "L" : "M"}${x(p.month).toFixed(1)},${y(p.cash).toFixed(1)}`).join("")
					const breach = firstBelowZero(pts)
					const last = pts[pts.length - 1]!
					return (
						<g key={s.id}>
							<path d={d} fill="none" stroke={SERIES[i % SERIES.length]} strokeWidth="2" strokeLinejoin="round" />
							{breach !== null && <circle cx={x(breach)} cy={y(pts[breach]!.cash)} r="5" fill="var(--bg)" stroke="var(--crit)" strokeWidth="2"><title>{`${s.name}: cash below zero from month ${breach}`}</title></circle>}
							<text x={x(last.month) + 6} y={y(last.cash) + 4} style={{ fill: "var(--ink)", fontFamily: "var(--sans)", fontSize: 12 }}>{s.name}</text>
						</g>
					)
				})}
			</svg>
			<p className="note">Ringed point = first month cash drops below zero. Reconstructed from yearly revenue, cost and tranche releases; the engine's monthly figures are authoritative.</p>
			<details>
				<summary className="note" style={{ cursor: "pointer" }}>Table view</summary>
				<table>
					<thead><tr><th>Month</th>{curves.map((c) => <th key={c.s.id} className="r">{c.s.name}</th>)}</tr></thead>
					<tbody>
						{[0, 6, 12, 18, 24, 36].filter((m) => m <= months).map((m) => (
							<tr key={m}><td className="num" style={{ textAlign: "left" }}>{m}</td>{curves.map((c) => <td key={c.s.id} className="num">{compact(c.pts[m]!.cash)}</td>)}</tr>
						))}
					</tbody>
				</table>
			</details>
		</>
	)
}

function EditorRow({ a, onChange, onFocusFindings }: { a: Assumption; onChange: (id: string, v: number | null) => void; onFocusFindings: (ids: string[]) => void }) {
	const [v, setV] = useState(effective(a))
	const t = useRef<number>()
	useEffect(() => setV(effective(a)), [a.user_override, a.base])
	const pinned = isPinned(a)
	const step = (a.high - a.low) / 100 || 0.01
	const commit = (n: number) => {
		setV(n)
		window.clearTimeout(t.current)
		t.current = window.setTimeout(() => onChange(a.id, n), 250)
	}
	return (
		<div className={`edit${pinned ? " pinned" : ""}`} role="group" aria-label={a.text}>
			<span className="num" aria-hidden="true">{a.sensitivity_rank ?? "·"}</span>
			<div className="name">
				<b>{a.text}</b>
				<span>
					{a.origin === "default" ? "Default, not evidence-based" : a.origin === "user" ? "Your input" : "From research"} · confidence {pct(a.confidence ?? 0)}
					{a.basis_finding_ids?.length ? <> · <button className="btn link" onClick={() => onFocusFindings(a.basis_finding_ids!)}>{a.basis_finding_ids.length} finding{a.basis_finding_ids.length > 1 ? "s" : ""}</button></> : " · no source findings"}
				</span>
			</div>
			<div>
				<input type="range" min={a.low} max={a.high} step={step} value={v} disabled={READ_ONLY} onChange={(e) => commit(Number(e.target.value))} aria-label={`${a.text} (${a.unit})`} aria-valuetext={`${v.toPrecision(3)} ${a.unit}`} />
				<div className="vals"><span>{a.low}</span><span>base {a.base}</span><span>{a.high}</span></div>
			</div>
			<div className="cur">
				{Number(v.toPrecision(4))} <span className="note">{a.unit}</span>
				{pinned && (
					<>
						<span className="pin">Pinned by you</span>
						{!READ_ONLY && <button className="btn link" onClick={() => onChange(a.id, null)}>Reset to {a.base}</button>}
					</>
				)}
			</div>
		</div>
	)
}

export function Financials({ scenarios, assumptions, opening, onOverride, onFocusFindings }: { scenarios: Scenario[]; assumptions: Assumption[]; opening?: number; onOverride: (id: string, v: number | null) => void; onFocusFindings: (ids: string[]) => void }) {
	const sorted = [...assumptions].sort((a, b) => (a.sensitivity_rank ?? 99) - (b.sensitivity_rank ?? 99))
	return (
		<Section id="financials" n="03" title="Financials" lede="Scenarios are computed by code from the assumptions below. Move an assumption to see how every figure responds.">
			{scenarios.length === 0 ? <p className="note">No scenarios computed yet.</p> : (
				<div className="grid2">
					<div><Scenarios scenarios={scenarios} /></div>
					<div><CashChart scenarios={scenarios} opening={opening} /></div>
				</div>
			)}
			<h3 className="sub">Assumptions, most influential first{READ_ONLY ? " (read-only)" : ""}</h3>
			{sorted.length === 0 ? <p className="note">No assumptions yet.</p> : sorted.map((a) => <EditorRow key={a.id} a={a} onChange={onOverride} onFocusFindings={onFocusFindings} />)}
			<p className="foot">{money(opening ?? 0)} opening cash used for the curve{opening === undefined ? " (not provided; curve shows change only)" : ""}. Rank 1 is the assumption whose range moves the result most.</p>
		</Section>
	)
}
