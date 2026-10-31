// Intake form logic: what `POST /runs` needs, client-side checks (the server's Ajv pass stays the authority),
// recommendations derived from the profile, the agent count sized from the budget, and the localStorage draft.
import type { Budget, CompanyProfile } from "./types/contracts.ts"

export type Role = "scout" | "collector" | "analyst" | "verifier"
export const ROLES: Role[] = ["scout", "collector", "analyst", "verifier"]

/** What the form holds. Worker slots are not a user choice: `sizeSlots` derives them from the budget at submit. */
export interface Intake {
	profile: CompanyProfile
	auto_approve: boolean
}

export const DRAFT_KEY = "intake.draft"

/** Mirrors the orchestrator defaults (`defaultRunBudget`); the team gateway budget is $20 for all runs. */
export const RECOMMENDED = { usd: 4, seconds: 1800 }

/** Measured on the 2026-10-30 runs (Haiku workers, 6 slots): 0.03-0.05 USD per slot-minute including the planner. */
export const USD_PER_SLOT_MINUTE = 0.04
/** Roles are added in this order as the budget allows: a scout, collector and analyst first (nothing works without them), a verifier next, then parallelism. The planner caps topics per collector+analyst+verifier trio, so the eighth slot is a second verifier, not a third scout. */
const SLOT_ORDER: Role[] = ["scout", "collector", "analyst", "verifier", "scout", "analyst", "collector", "verifier"]

/** Agents per role that the money can keep busy for the whole runtime: enough to spend the budget in the time given, never fewer than one scout/collector/analyst. */
export function sizeSlots(b: Budget = {}): Record<Role, number> {
	const minutes = (b.seconds ?? RECOMMENDED.seconds) / 60
	const n = Math.min(SLOT_ORDER.length, Math.max(3, Math.round((b.usd ?? RECOMMENDED.usd) / (USD_PER_SLOT_MINUTE * Math.max(1, minutes)))))
	const slots: Record<Role, number> = { scout: 0, collector: 0, analyst: 0, verifier: 0 }
	for (const r of SLOT_ORDER.slice(0, n)) slots[r]++
	return slots
}

export interface Advice {
	run_budget: Budget
	horizon_years: number
	risk_appetite: CompanyProfile["risk_appetite"]
	investable_budget?: number
	/** Months of cash at the stated net burn; null when the company is cash-positive. */
	runway_months: number | null
}

/** Suggestions for the fields a user usually does not know how to set. Pure; no LLM. */
export function recommend(p: CompanyProfile): Advice {
	const f = p.financials ?? {}
	const extra = Math.max(0, (p.products?.length ?? 1) - 1)
	const netBurn = (f.monthly_burn ?? 0) - (f.annual_revenue ?? 0) / 12
	const runway = netBurn > 0 && f.cash_on_hand !== undefined ? f.cash_on_hand / netBurn : null
	return {
		// More products -> more topics -> more time and money; both stay under the team cap.
		run_budget: { usd: Math.min(10, RECOMMENDED.usd + extra), seconds: Math.min(3600, RECOMMENDED.seconds + 600 * extra) },
		horizon_years: 3,
		risk_appetite: runway !== null && runway < 6 ? "low" : runway === null && (f.cash_on_hand ?? 0) > 12 * (f.monthly_burn ?? 0) ? "high" : "medium",
		investable_budget: f.cash_on_hand !== undefined ? Math.round(f.cash_on_hand * 0.5) : undefined,
		runway_months: runway === null ? null : Math.round(runway * 10) / 10,
	}
}

export interface Report {
	/** Blocks the start. */
	errors: string[]
	/** Shown, does not block. */
	warnings: string[]
}

const isInt = (n: number | undefined) => n === undefined || Number.isInteger(n)
const nonNeg = (n: number | undefined) => n === undefined || (Number.isFinite(n) && n >= 0)

/** Field-level checks mirroring company_profile.schema.json plus sanity rules the schema cannot express. */
export function check(i: Intake): Report {
	const errors: string[] = []
	const warnings: string[] = []
	const p = i.profile
	const f = p.financials ?? {}
	const b = p.run_budget ?? {}

	if (!p.name?.trim()) errors.push("Company name is required.")
	if (!p.description?.trim()) errors.push("Company description is required.")
	else if (p.description.trim().length < 40) warnings.push("The description is very short; the planner will have to guess what the company does.")
	if (!isInt(p.headcount) || !nonNeg(p.headcount)) errors.push("Headcount must be a whole number of 0 or more.")
	if (p.currency && !/^[A-Z]{3}$/.test(p.currency)) errors.push("Currency must be a 3-letter ISO code such as EUR.")
	for (const c of p.countries ?? []) if (c && !/^[A-Z]{2}$/.test(c)) warnings.push(`Country "${c}" is not a 2-letter ISO code; the planner may misread it.`)
	if (p.horizon_years !== undefined && (!Number.isInteger(p.horizon_years) || p.horizon_years < 1 || p.horizon_years > 10)) errors.push("Horizon must be a whole number of years between 1 and 10.")

	const products = (p.products ?? []).filter((x) => x.name?.trim() || x.description?.trim())
	if (products.length === 0) errors.push("At least one product with a name and description is required.")
	products.forEach((x, n) => {
		if (!x.name?.trim() || !x.description?.trim()) errors.push(`Product ${n + 1} needs both a name and a description.`)
		if (!nonNeg(x.annual_revenue) || !nonNeg(x.annual_cost)) errors.push(`Product ${n + 1}: revenue and cost cannot be negative.`)
		else if (x.annual_cost !== undefined && x.annual_revenue !== undefined && x.annual_cost > x.annual_revenue && (x.stage === "mature" || x.stage === "declining"))
			warnings.push(`Product ${n + 1} is ${x.stage} but costs more than it earns; check the figures.`)
	})

	for (const [k, v] of Object.entries(f)) if (v !== undefined && !Number.isFinite(v)) errors.push(`Financials: ${k.replaceAll("_", " ")} must be a number.`)
	if (f.investable_budget !== undefined && f.cash_on_hand !== undefined && f.investable_budget > f.cash_on_hand) warnings.push("Investable budget exceeds cash on hand.")
	const runway = recommend(p).runway_months
	if (runway !== null && runway < 6) warnings.push(`Runway is about ${runway} months at the stated burn; consider a low risk appetite.`)

	if (!nonNeg(b.usd)) errors.push("Max price must be 0 or more.")
	else if (b.usd !== undefined && b.usd < 0.5) errors.push("Max price under $0.50 cannot pay for the planner call.")
	else if (b.usd !== undefined && b.usd > 10) warnings.push("Max price above $10 is half the whole team's gateway budget.")
	if (!isInt(b.seconds) || !nonNeg(b.seconds)) errors.push("Max runtime must be a whole number of seconds, 0 or more.")
	else if (b.seconds !== undefined && b.seconds < 300) errors.push("Max runtime under 5 minutes cannot finish a single research task.")
	else if (b.seconds !== undefined && b.seconds < 900) warnings.push("Max runtime under 15 minutes usually ends with a partial plan.")
	if (!isInt(b.tokens) || !nonNeg(b.tokens)) errors.push("Token cap must be a whole number, 0 or more.")
	if (!isInt(b.calls) || !nonNeg(b.calls)) errors.push("Search-call cap must be a whole number, 0 or more.")
	return { errors, warnings }
}

/** The `POST /runs` body: trimmed strings, blanks and undefined numbers dropped so the server's `additionalProperties:false` / pattern rules pass on optional fields the user left empty, and the slots sized from the budget. */
export function clean(i: Intake): { profile: CompanyProfile; auto_approve: boolean; slots: Record<Role, number> } {
	const strip = (o: object): object =>
		Object.fromEntries(
			Object.entries(o).flatMap(([k, v]) => {
				if (typeof v === "string") return v.trim() ? [[k, v.trim()]] : []
				if (Array.isArray(v)) {
					const a = v.map((x) => (typeof x === "string" ? x.trim() : typeof x === "object" && x ? strip(x) : x)).filter((x) => x !== "" && x !== undefined)
					return a.length ? [[k, a]] : []
				}
				if (v && typeof v === "object") {
					const s = strip(v)
					return Object.keys(s).length ? [[k, s]] : []
				}
				return v === undefined ? [] : [[k, v]]
			}),
		)
	const profile = strip({ ...i.profile, products: (i.profile.products ?? []).filter((x) => x.name?.trim() || x.description?.trim()) }) as CompanyProfile
	return { profile: { ...profile, schema_version: "1.0" }, auto_approve: i.auto_approve, slots: sizeSlots(i.profile.run_budget) }
}

export function loadDraft(): Intake | undefined {
	try {
		const s = localStorage.getItem(DRAFT_KEY)
		return s ? (JSON.parse(s) as Intake) : undefined
	} catch {
		return undefined
	}
}
export function saveDraft(i: Intake): void {
	try {
		localStorage.setItem(DRAFT_KEY, JSON.stringify(i))
	} catch {
		/* private mode / quota: the form still works, it just is not remembered */
	}
}
