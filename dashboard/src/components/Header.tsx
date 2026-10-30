import { useEffect, useState } from "react"
import type { Conn, RunSummary } from "../api.ts"
import { READ_ONLY } from "../api.ts"
import { compact, label } from "../fmt.ts"
import { Chip } from "../ui.tsx"

function Meter({ name, used, cap, unit }: { name: string; used?: number; cap?: number; unit: string }) {
	if (cap === undefined) return null
	const u = used ?? 0
	const ratio = cap ? u / cap : 0
	return (
		<div className="meter">
			<span>{name}</span>
			<b>{unit === "USD" ? `${u.toFixed(2)} / ${cap.toFixed(2)} USD` : unit === "min" ? `${Math.round(u / 60)} / ${Math.round(cap / 60)} min` : `${compact(u)} / ${compact(cap)}`}</b>
			<div className={`bar${ratio > 0.8 ? " hot" : ""}`} role="meter" aria-label={name} aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
				<i style={{ width: `${Math.min(100, ratio * 100)}%` }} />
			</div>
		</div>
	)
}

export function Header({ run, conn }: { run?: RunSummary; conn: Conn }) {
	const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? "")
	useEffect(() => {
		if (!theme) return
		document.documentElement.dataset.theme = theme
		try { localStorage.setItem("ss-theme", theme) } catch { /* private mode */ }
	}, [theme])
	const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
	const b = run?.budget
	const s = run?.spent
	const remaining = b?.seconds !== undefined ? Math.max(0, b.seconds - (s?.seconds ?? 0)) : undefined
	return (
		<header className="hdr">
			<div>
				<div className="brand">Strategy Swarm</div>
				<h1 className="company">{run?.profile?.name ?? "Loading run"}</h1>
			</div>
			<div className="hdr-tools">
				{run && <Chip kind={run.status === "done" ? "closed" : run.status === "failed" ? "flag" : "deep"}>{label(run.status)}</Chip>}
				{conn === "reconnecting" && <Chip kind="stale">Reconnecting</Chip>}
				{READ_ONLY && <Chip kind="queued">Read-only</Chip>}
				<button className="btn" onClick={() => setTheme(dark ? "light" : "dark")} aria-pressed={dark}>{dark ? "Light" : "Dark"}</button>
				<a className="btn" href="#export">Export</a>
			</div>
			{b && (
				<div className="meters">
					<Meter name="Spend" used={s?.usd} cap={b.usd} unit="USD" />
					<Meter name="Time" used={s?.seconds} cap={b.seconds} unit="min" />
					<Meter name="Tokens" used={s?.tokens} cap={b.tokens} unit="n" />
					<Meter name="Calls" used={s?.calls} cap={b.calls} unit="n" />
					{remaining !== undefined && run?.status !== "done" && (
						<div className="meter"><span>Time left (at most)</span><b>{Math.round(remaining / 60)} min</b></div>
					)}
				</div>
			)}
		</header>
	)
}
