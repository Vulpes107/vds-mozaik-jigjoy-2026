import { useEffect, useMemo, useState } from "react"
import sample from "../../../mocks/company_profile.sample.json"
import { startRun, stopRun } from "../api.ts"
import { check, clean, loadDraft, recommend, RECOMMENDED, saveDraft, sizeSlots, type Intake as IntakeT } from "../intake.ts"
import type { CompanyProfile } from "../types/contracts.ts"

type Product = CompanyProfile["products"][number]
const STAGES: NonNullable<Product["stage"]>[] = ["idea", "prototype", "launched", "growth", "mature", "declining"]
const fromSample = (): IntakeT => ({ profile: { ...(structuredClone(sample) as CompanyProfile), run_budget: { ...RECOMMENDED } }, auto_approve: false })
const num = (s: string) => (s === "" ? undefined : Number(s))
const lines = (s: string) => s.split("\n")
const commas = (s: string) => s.split(",").map((x) => x.trim())

/** Intake form: company profile + run limits; the swarm size follows from the limits. Validated locally, then by the server; the draft is kept in localStorage. */
export function Intake() {
	const [i, setI] = useState<IntakeT>(() => loadDraft() ?? fromSample())
	const [report, setReport] = useState<{ errors: string[]; warnings: string[] }>()
	const [serverErr, setServerErr] = useState<string>()
	const [blocking, setBlocking] = useState<string>() // id of the in-progress run the server refused to replace
	const [busy, setBusy] = useState(false)
	useEffect(() => saveDraft(i), [i])
	const advice = useMemo(() => recommend(i.profile), [i.profile])
	const slots = sizeSlots(i.profile.run_budget)
	const p = i.profile
	const f = p.financials ?? {}
	const b = p.run_budget ?? {}

	const setP = (patch: Partial<CompanyProfile>) => setI((s) => ({ ...s, profile: { ...s.profile, ...patch } }))
	const setF = (patch: Partial<NonNullable<CompanyProfile["financials"]>>) => setP({ financials: { ...f, ...patch } })
	const setB = (patch: Partial<NonNullable<CompanyProfile["run_budget"]>>) => setP({ run_budget: { ...b, ...patch } })
	const setProduct = (n: number, patch: Partial<Product>) => setP({ products: p.products.map((x, k) => (k === n ? { ...x, ...patch } : x)) as CompanyProfile["products"] })

	/** Errors always block. Warnings block too, until the user picks "Start anyway". Nothing is posted and the page stays put until then. */
	const start = async (opts: { anyway?: boolean; stopFirst?: string } = {}) => {
		const r = check(i)
		setReport(r)
		setServerErr(undefined)
		setBlocking(undefined)
		if (r.errors.length || (r.warnings.length && !opts.anyway)) return
		setBusy(true)
		try {
			if (opts.stopFirst) await stopRun(opts.stopFirst)
			const id = await startRun(clean(i))
			location.search = `?run=${id}` // reload on the new run
		} catch (e) {
			const err = e as Error & { status?: number; run_id?: string }
			setServerErr(err.message)
			if (err.status === 409 && err.run_id) setBlocking(err.run_id)
			setBusy(false)
		}
	}
	const applyAdvice = () => {
		setI((s) => ({ ...s, profile: { ...s.profile, run_budget: advice.run_budget, horizon_years: s.profile.horizon_years ?? advice.horizon_years, risk_appetite: s.profile.risk_appetite ?? advice.risk_appetite, financials: { ...f, investable_budget: f.investable_budget ?? advice.investable_budget } } }))
	}

	return (
		<form className="form" onSubmit={(e) => { e.preventDefault(); void start() }} noValidate>
			<fieldset>
				<legend>Company</legend>
				<Field label="Name" req><input value={p.name} onChange={(e) => setP({ name: e.target.value })} required /></Field>
				<Field label="What the company does" req hint="A few sentences. The planner derives the research topics from this."><textarea rows={3} value={p.description} onChange={(e) => setP({ description: e.target.value })} required /></Field>
				<div className="cols">
					<Field label="Industry"><input value={p.industry ?? ""} onChange={(e) => setP({ industry: e.target.value })} /></Field>
					<Field label="Headcount"><input type="number" min={0} step={1} value={p.headcount ?? ""} onChange={(e) => setP({ headcount: num(e.target.value) })} /></Field>
					<Field label="Currency" hint="3-letter ISO code"><input value={p.currency ?? ""} maxLength={3} onChange={(e) => setP({ currency: e.target.value.toUpperCase() })} /></Field>
					<Field label="Countries" hint="2-letter codes, comma-separated"><input value={(p.countries ?? []).join(", ")} onChange={(e) => setP({ countries: commas(e.target.value) })} /></Field>
				</div>
				<div className="cols">
					<Field label="Goals" hint="One per line"><textarea rows={3} value={(p.goals ?? []).join("\n")} onChange={(e) => setP({ goals: lines(e.target.value) })} /></Field>
					<Field label="Constraints" hint="One per line"><textarea rows={3} value={(p.constraints ?? []).join("\n")} onChange={(e) => setP({ constraints: lines(e.target.value) })} /></Field>
				</div>
				<Field label="Notes"><textarea rows={2} value={p.notes ?? ""} onChange={(e) => setP({ notes: e.target.value })} /></Field>
			</fieldset>

			<fieldset>
				<legend>Products</legend>
				{p.products.map((x, n) => (
					<div className="product" key={n}>
						<div className="cols">
							<Field label={`Product ${n + 1} name`} req><input value={x.name} onChange={(e) => setProduct(n, { name: e.target.value })} /></Field>
							<Field label="Stage">
								<select value={x.stage ?? ""} onChange={(e) => setProduct(n, { stage: (e.target.value || undefined) as Product["stage"] })}>
									<option value="">—</option>
									{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
								</select>
							</Field>
							<Field label="Annual revenue"><input type="number" min={0} value={x.annual_revenue ?? ""} onChange={(e) => setProduct(n, { annual_revenue: num(e.target.value) })} /></Field>
							<Field label="Annual cost"><input type="number" min={0} value={x.annual_cost ?? ""} onChange={(e) => setProduct(n, { annual_cost: num(e.target.value) })} /></Field>
						</div>
						<Field label="Description" req><input value={x.description} onChange={(e) => setProduct(n, { description: e.target.value })} /></Field>
						{p.products.length > 1 && <button type="button" className="btn link" onClick={() => setP({ products: p.products.filter((_, k) => k !== n) as CompanyProfile["products"] })}>Remove product {n + 1}</button>}
					</div>
				))}
				<button type="button" className="btn" onClick={() => setP({ products: [...p.products, { name: "", description: "" }] })}>Add product</button>
			</fieldset>

			<fieldset>
				<legend>Financials</legend>
				<div className="cols">
					<Field label="Annual revenue"><input type="number" value={f.annual_revenue ?? ""} onChange={(e) => setF({ annual_revenue: num(e.target.value) })} /></Field>
					<Field label="Monthly burn" hint="Total monthly cost"><input type="number" value={f.monthly_burn ?? ""} onChange={(e) => setF({ monthly_burn: num(e.target.value) })} /></Field>
					<Field label="Cash on hand"><input type="number" value={f.cash_on_hand ?? ""} onChange={(e) => setF({ cash_on_hand: num(e.target.value) })} /></Field>
					<Field label="Investable budget" hint={advice.investable_budget !== undefined ? `Recommended: ${advice.investable_budget.toLocaleString()} (half of cash on hand)` : undefined}><input type="number" value={f.investable_budget ?? ""} onChange={(e) => setF({ investable_budget: num(e.target.value) })} /></Field>
				</div>
				<div className="cols">
					<Field label="Risk appetite" hint={`Recommended: ${advice.risk_appetite}${advice.runway_months !== null ? ` (runway ≈ ${advice.runway_months} months)` : " (cash-positive)"}`}>
						<select value={p.risk_appetite ?? ""} onChange={(e) => setP({ risk_appetite: (e.target.value || undefined) as CompanyProfile["risk_appetite"] })}>
							<option value="">—</option>
							{(["low", "medium", "high"] as const).map((s) => <option key={s} value={s}>{s}</option>)}
						</select>
					</Field>
					<Field label="Horizon (years)" hint={`Recommended: ${advice.horizon_years}`}><input type="number" min={1} max={10} step={1} value={p.horizon_years ?? ""} onChange={(e) => setP({ horizon_years: num(e.target.value) })} /></Field>
				</div>
			</fieldset>

			<fieldset>
				<legend>Research limits</legend>
				<p className="hint">Hard caps: the swarm stops at whichever is hit first and delivers a partial plan. Empty = server default.</p>
				<div className="cols">
					<Field label="Max price (USD)" hint={`Recommended: ${advice.run_budget.usd}`}><input type="number" min={0} step={0.5} value={b.usd ?? ""} onChange={(e) => setB({ usd: num(e.target.value) })} /></Field>
					<Field label="Max runtime (seconds)" hint={`Recommended: ${advice.run_budget.seconds} (${Math.round(advice.run_budget.seconds! / 60)} min)`}><input type="number" min={0} step={60} value={b.seconds ?? ""} onChange={(e) => setB({ seconds: num(e.target.value) })} /></Field>
					<Field label="Max LLM tokens" hint="Optional"><input type="number" min={0} step={1000} value={b.tokens ?? ""} onChange={(e) => setB({ tokens: num(e.target.value) })} /></Field>
					<Field label="Max search calls" hint="Optional"><input type="number" min={0} step={1} value={b.calls ?? ""} onChange={(e) => setB({ calls: num(e.target.value) })} /></Field>
				</div>
				<p className="hint">
					Swarm sized for this budget: {(Object.entries(slots) as [string, number][]).filter(([, n]) => n > 0).map(([r, n]) => `${n} ${r}${n > 1 ? "s" : ""}`).join(", ")}. Agents are added as the money per minute allows; the roles stay balanced.
				</p>
				<label className="check"><input type="checkbox" checked={i.auto_approve} onChange={(e) => setI((s) => ({ ...s, auto_approve: e.target.checked }))} /> Skip the topic-approval checkpoint (the swarm starts spending without asking)</label>
				<p className="row"><button type="button" className="btn" onClick={applyAdvice}>Use recommended values</button></p>
			</fieldset>

			{report && report.errors.length > 0 && (
				<div className="banner crit" role="alert"><b>Fix these before starting</b><ul>{report.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
			)}
			{report && report.errors.length === 0 && report.warnings.length > 0 && (
				<div className="banner" role="status">
					<b>Not started yet: worth a second look</b>
					<ul>{report.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
					<div className="row">
						<button type="button" className="btn primary" disabled={busy} onClick={() => void start({ anyway: true })}>Start anyway</button>
						<span className="hint">or change the fields above and press Start run again</span>
					</div>
				</div>
			)}
			{serverErr && (
				<div className="banner crit" role="alert">
					<b>{blocking ? "A run is still in progress" : "The server rejected the request"}</b>
					<pre>{serverErr}</pre>
					{blocking && (
						<div className="row">
							<a className="btn" href={`?run=${blocking}`}>Open it</a>
							<button type="button" className="btn primary" disabled={busy} onClick={() => void start({ anyway: true, stopFirst: blocking })}>Stop it and start this one</button>
						</div>
					)}
				</div>
			)}
			<p className="row">
				<button type="submit" className="btn primary" disabled={busy}>{busy ? "Starting…" : "Start run"}</button>
				<button type="button" className="btn" onClick={() => { setI(fromSample()); setReport(undefined) }}>Reset to example</button>
			</p>
		</form>
	)
}

function Field({ label, req, hint, children }: { label: string; req?: boolean; hint?: string; children: React.ReactNode }) {
	return (
		<label className="field">
			<span>{label}{req && <abbr title="required"> *</abbr>}</span>
			{children}
			{hint && <small className="hint">{hint}</small>}
		</label>
	)
}
