import type { ReactNode } from "react"
import { clamp, label } from "./fmt.ts"

export const Chip = ({ kind, children }: { kind: string; children?: ReactNode }) => <span className={`chip ${kind}`}>{children ?? label(kind)}</span>

export function Section({ id, title, lede, children, keep }: { id: string; n?: string; title: string; lede?: string; children: ReactNode; keep?: boolean }) {
	return (
		<section className={`section${keep ? " keep" : ""}`} id={id} aria-labelledby={`${id}-h`}>
			<h2 id={`${id}-h`}>
				{title}
			</h2>
			{lede && <p className="lede">{lede}</p>}
			{children}
		</section>
	)
}

export const Banner = ({ kind = "warn", title, children }: { kind?: "warn" | "crit" | "info"; title: string; children?: ReactNode }) => (
	<div className={`banner ${kind === "warn" ? "" : kind}`} role={kind === "crit" ? "alert" : "status"}>
		<b>{title}</b>
		{children}
	</div>
)

/** Low / base / high on a shared scale. Optional ticks mark e.g. tranche releases. */
export function RangeBar({ min, max, low, base, high, ticks = [], zero, fmt, ariaLabel }: { min: number; max: number; low?: number; base: number; high?: number; ticks?: number[]; zero?: boolean; fmt: (n: number) => string; ariaLabel: string }) {
	const span = max - min || 1
	const at = (v: number) => `${clamp(((v - min) / span) * 100, 0, 100)}%`
	const lo = low ?? base
	const hi = high ?? base
	return (
		<div className="range" role="img" aria-label={`${ariaLabel}: ${fmt(lo)} to ${fmt(hi)}, base ${fmt(base)}`}>
			<div className="line" />
			{zero && min <= 0 && max > 0 && <div className="zl" style={{ left: at(0) }}><span>0</span></div>}
			<div className="span" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
			{ticks.map((t, i) => (
				<div key={i} className="tick" style={{ left: at(t) }} />
			))}
			<div className="base" style={{ left: at(base) }} />
			{low !== undefined && <span className="lbl" style={{ left: at(lo) }}>{fmt(lo)}</span>}
			<span className="lbl" style={{ left: at(base), top: 24 }}>{fmt(base)}</span>
			{high !== undefined && <span className="lbl" style={{ left: at(hi) }}>{fmt(hi)}</span>}
		</div>
	)
}

// Agent identity: colour AND shape, so it never rests on colour alone.
const ROLE: Record<string, { color: string; shape: string }> = {
	scout: { color: "var(--c-scout)", shape: "circle" },
	collector: { color: "var(--c-collector)", shape: "square" },
	analyst: { color: "var(--c-analyst)", shape: "triangle" },
	verifier: { color: "var(--c-verifier)", shape: "diamond" },
}
export const roleStyle = (role: string) => ROLE[role] ?? { color: "var(--c-other)", shape: "hex" }

export function Glyph({ role }: { role: string }) {
	const { color, shape } = roleStyle(role)
	const p = { fill: color }
	return (
		<svg viewBox="0 0 12 12" aria-hidden="true">
			{shape === "circle" && <circle cx="6" cy="6" r="5" {...p} />}
			{shape === "square" && <rect x="1" y="1" width="10" height="10" {...p} />}
			{shape === "triangle" && <path d="M6 1 11 11H1z" {...p} />}
			{shape === "diamond" && <path d="M6 0 12 6 6 12 0 6z" {...p} />}
			{shape === "hex" && <path d="M3 1h6l3 5-3 5H3L0 6z" {...p} />}
		</svg>
	)
}

/** A chart with its explanation beside it: what question it answers, how to read it, and what it shows right now. */
export function Figure({ title, question, read, now, children }: { title: string; question: string; read: string[]; now: string[]; children: ReactNode }) {
	return (
		<figure className="fig">
			<div className="fig-main">
				<h3 className="fig-t">{title}</h3>
				<p className="fig-q">{question}</p>
				{children}
			</div>
			<figcaption className="fig-aside">
				<h4>What you are looking at</h4>
				<ul>{read.map((r) => <li key={r}>{r}</li>)}</ul>
				<h4>What it shows right now</h4>
				<ul className="now">{now.map((r) => <li key={r}>{r}</li>)}</ul>
			</figcaption>
		</figure>
	)
}

export function Kpi({ label: l, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "crit" | "good" }) {
	return (
		<div className={`kpi${tone ? ` ${tone}` : ""}`}>
			<span className="kpi-l">{l}</span>
			<span className="kpi-v">{value}</span>
			{sub && <span className="kpi-s">{sub}</span>}
		</div>
	)
}
