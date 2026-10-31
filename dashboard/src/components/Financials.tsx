import { useEffect, useMemo, useRef, useState } from "react"
import type { Assumption, Scenario } from "../types/contracts.ts"
import { READ_ONLY } from "../api.ts"
import { cashCurve, cashFacts, cashStory, effective, groupScenarios, isPinned, npvStory } from "../derive.ts"
import { compact, money, pct } from "../fmt.ts"
import { Chip, Figure, RangeBar, Section } from "../ui.tsx"

const SERIES = ["var(--c-scout)", "var(--c-collector)", "var(--c-analyst)", "var(--c-verifier)", "var(--c-other)"]

function niceTicks(lo: number, hi: number, n = 4): number[] {
	const raw = (hi - lo) / n || 1
	const mag = 10 ** Math.floor(Math.log10(raw))
	const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
	const out: number[] = []
	for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6)
	return out
}

function NpvChart({ scenarios }: { scenarios: Scenario[] }) {
	const groups = groupScenarios(scenarios)
	const cur = scenarios[0]?.currency ?? ""
	const npvs = groups.flatMap((g) => [g.low, g.base, g.high].map((s) => s?.metrics?.npv).filter((x): x is number => x !== undefined))
	const min = Math.min(0, ...npvs) * 1.15
	const max = Math.max(0, ...npvs) * 1.15 || 1
	return (
		<Figure
			title="Value of each option"
			question="Which choice creates the most value over the planning horizon?"
			read={[
				"Each row is one strategy. The marker is its net present value (NPV): all future cash in and out, discounted back to today.",
				"The thin vertical line is zero. Right of it creates value, left of it destroys value.",
				"A grey band, when shown, runs from the adverse to the favourable case.",
			]}
			now={npvStory(groups, cur)}
		>
			<ul className="rank" style={{ listStyle: "none", padding: 0, margin: 0 }}>
				{groups.map((g) => (
					<li key={g.kind} style={{ gridTemplateColumns: "120px 1fr", alignItems: "start", paddingBottom: 22 }}>
						<span>
							{g.name}
							{g.base.metrics?.runway_breached && <div style={{ marginTop: 4 }}><Chip kind="flag">Runs out of cash</Chip></div>}
						</span>
						<RangeBar min={min} max={max} low={g.low?.metrics?.npv} base={g.base.metrics?.npv ?? 0} high={g.high?.metrics?.npv} zero fmt={compact} ariaLabel={`${g.name} NPV`} />
					</li>
				))}
			</ul>
			<table>
				<thead><tr><th>Scenario</th><th className="r">NPV</th><th className="r">Return (IRR)</th><th className="r">Payback</th><th className="r">Break-even</th><th className="r">Lowest cash</th></tr></thead>
				<tbody>
					{groups.map((g) => {
						const m = g.base.metrics
						return (
							<tr key={g.kind}>
								<td>{g.name}</td>
								<td className="num">{m?.npv !== undefined ? compact(m.npv) : "—"}</td>
								<td className="num">{m?.irr != null ? pct(m.irr) : "n/a"}</td>
								<td className="num">{m?.payback_months != null ? `${m.payback_months} mo` : "n/a"}</td>
								<td className="num">{m?.break_even_month != null ? `month ${m.break_even_month}` : "n/a"}</td>
								<td className="num" style={m?.min_cash_balance !== undefined && m.min_cash_balance < 0 ? { color: "var(--crit)" } : undefined}>{m?.min_cash_balance !== undefined ? compact(m.min_cash_balance) : "—"}</td>
							</tr>
						)
					})}
				</tbody>
			</table>
			<p className="note" style={{ marginTop: 8 }}>Amounts in {cur}. n/a = not reached within the horizon.</p>
		</Figure>
	)
}

function CashChart({ scenarios, opening }: { scenarios: Scenario[]; opening: number | undefined }) {
	const base = useMemo(() => scenarios.filter((s) => (s.case ?? "base") === "base"), [scenarios])
	const curves = useMemo(() => base.map((s) => ({ s, pts: cashCurve(s, opening ?? 0) })), [base, opening])
	if (!curves.length) return null
	const cur = base[0]?.currency ?? ""
	const W = 640, H = 300, L = 54, R = 120, T = 16, B = 30
	const months = Math.max(...curves.map((c) => c.pts.length - 1))
	const all = curves.flatMap((c) => c.pts.map((p) => p.cash))
	const lo = Math.min(0, ...all), hi = Math.max(0, ...all)
	const pad = (hi - lo) * 0.06
	const x = (m: number) => L + (m / months) * (W - L - R)
	const y = (v: number) => T + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad) || 1)) * (H - T - B)
	const ticks = niceTicks(lo, hi)
	// end labels: push apart so they never overlap
	const ends = curves.map((c, i) => ({ i, y: y(c.pts[c.pts.length - 1]!.cash) })).sort((a, b) => a.y - b.y)
	for (let j = 1; j < ends.length; j++) if (ends[j]!.y - ends[j - 1]!.y < 15) ends[j]!.y = ends[j - 1]!.y + 15
	const endY = new Map(ends.map((e) => [e.i, e.y]))
	const facts = curves.map((c) => cashFacts(c.s.name, c.pts))
	return (
		<Figure
			title="Cash balance over time"
			question="Do we run out of money on the way to the payoff?"
			read={[
				"Each line is the cumulative cash in the bank under one strategy, starting from today's cash.",
				"The dark horizontal line is zero. Anything below it means we cannot pay our bills without new funding.",
				"A ringed point marks the first month a line goes below zero; the label beneath shows the lowest balance.",
				"Steps down are money released in tranches; the slope afterwards is yearly revenue minus cost.",
			]}
			now={cashStory(facts, cur)}
		>
			<svg className="cash" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cumulative cash by scenario, with the zero line">
				{lo < 0 && <rect x={L} y={y(0)} width={W - L - R} height={y(lo - pad) - y(0)} fill="var(--crit-bg)" opacity="0.55" />}
				{ticks.map((t) => (
					<g key={t}>
						<line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--rule-soft)" />
						<text x={L - 8} y={y(t) + 4} textAnchor="end">{t === 0 ? "0" : compact(t)}</text>
					</g>
				))}
				<line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--ink)" strokeWidth="1.25" />
				{Array.from({ length: Math.floor(months / 12) + 1 }, (_, i) => (
					<text key={i} x={x(i * 12)} y={H - 8} textAnchor={i === 0 ? "start" : "middle"}>{i === 0 ? "today" : `year ${i}`}</text>
				))}
				{lo < 0 && <text x={W - R - 6} y={y(lo - pad) - 6} textAnchor="end" style={{ fill: "var(--crit)" }}>below zero: needs new funding</text>}
				{curves.map(({ s, pts }, i) => {
					const d = pts.map((p, kk) => `${kk ? "L" : "M"}${x(p.month).toFixed(1)},${y(p.cash).toFixed(1)}`).join("")
					const f = facts[i]!
					const last = pts[pts.length - 1]!
					const col = SERIES[i % SERIES.length]
					return (
						<g key={s.id}>
							<path d={d} fill="none" stroke={col} strokeWidth="2.25" strokeLinejoin="round" />
							{f.belowFrom !== null && (
								<>
									<circle cx={x(f.belowFrom)} cy={y(pts[f.belowFrom]!.cash)} r="5" fill="var(--bg)" stroke="var(--crit)" strokeWidth="2"><title>{`${s.name}: cash below zero from month ${f.belowFrom}`}</title></circle>
									<text x={x(f.lowMonth)} y={y(f.lowValue) + 18} textAnchor="middle" style={{ fill: "var(--ink)" }}>{`low ${compact(f.lowValue)}`}</text>
								</>
							)}
							<circle cx={x(last.month)} cy={y(last.cash)} r="3" fill={col} />
							<text x={x(last.month) + 8} y={endY.get(i)! + 4} style={{ fill: "var(--ink)", fontFamily: "var(--sans)", fontSize: 12 }}>{s.name} {compact(last.cash)}</text>
						</g>
					)
				})}
			</svg>
			<p className="note">Amounts in {cur}. Built from yearly totals and tranche releases, so month-to-month wiggles are smoothed; the engine's own lowest-cash figure (table above) is authoritative.</p>
			<details>
				<summary className="note" style={{ cursor: "pointer" }}>Show as a table</summary>
				<table>
					<thead><tr><th>Month</th>{curves.map((c) => <th key={c.s.id} className="r">{c.s.name}</th>)}</tr></thead>
					<tbody>
						{[0, 6, 12, 18, 24, 36].filter((m) => m <= months).map((m) => (
							<tr key={m}><td className="num" style={{ textAlign: "left" }}>{m}</td>{curves.map((c) => <td key={c.s.id} className="num">{compact(c.pts[m]!.cash)}</td>)}</tr>
						))}
					</tbody>
				</table>
			</details>
		</Figure>
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
	const pinned = assumptions.filter(isPinned).length
	return (
		<Section id="finance" title="Can we afford it?" lede="Every figure here is calculated by code from the assumptions at the bottom of this section, never written by the AI. Move an assumption to stress-test the plan.">
			{scenarios.length === 0 ? <p className="note">No scenarios computed yet.</p> : (
				<>
					<NpvChart scenarios={scenarios} />
					<CashChart scenarios={scenarios} opening={opening} />
				</>
			)}
			<figure className="fig">
				<div className="fig-main">
					<h3 className="fig-t">Assumptions you can change</h3>
					<p className="fig-q">What if the numbers behind the plan are wrong?</p>
					{sorted.length === 0 ? <p className="note">No assumptions yet.</p> : sorted.map((a) => <EditorRow key={a.id} a={a} onChange={onOverride} onFocusFindings={onFocusFindings} />)}
				</div>
				<figcaption className="fig-aside">
					<h4>How to use it</h4>
					<ul>
						<li>Drag a slider between the low and high estimate. The scenarios and the plan are recalculated by the engine.</li>
						<li>Number 1 is the assumption that moves the result most, so test it first.</li>
						<li>Your changes are marked "pinned" and can be reset to the researched value.</li>
						<li>"Default" means no evidence was found and a placeholder is used; treat those with care.</li>
					</ul>
					<h4>What it shows right now</h4>
					<ul className="now">
						<li>{sorted.length} assumptions, {pinned} pinned by you.</li>
						<li>{sorted.filter((a) => a.origin === "default").length} rely on defaults rather than evidence.</li>
						<li>Opening cash used: {money(opening ?? 0)}{opening === undefined ? " (not provided, so the cash chart shows change only)" : ""}.</li>
					</ul>
				</figcaption>
			</figure>
		</Section>
	)
}
