// Per-run analysis state: scenario specs, TCO results and the narrative live here (they are C's own working data);
// finished contract objects (assumptions, scenarios, plan) are written to the shared RunState after validation.
import type { RunState, Obj } from "../shared/runtime.ts"
import { assertValid } from "./contracts.ts"
import { assemblePlan, type BuildBuyInput, type Narrative, type PlanInput, type PlanOutput } from "./engine/plan.ts"
import { computeCompiled, compileSpec, indexAssumptions } from "./engine/scenario.ts"
import { rankAssumptions, tornado, type TornadoRow } from "./engine/sensitivity.ts"
import type { Assumption, Scenario, ScenarioSpec } from "./engine/types.ts"

export type Emit = (type: string, payload: unknown) => void

/** The company's own figures, seeded as assumptions so every scenario can reference them by a stable id. */
const PROFILE_FACTS = [
	{ key: "annual_revenue", text: "Existing annual revenue, as stated by the company", scale: 1 },
	{ key: "monthly_burn", text: "Existing annual operating cost, as stated by the company (monthly burn x 12)", scale: 12 },
	{ key: "investable_budget", text: "Investable budget, as stated by the company", scale: 1 },
] as const

export class AnalysisSession {
	readonly specs = new Map<string, ScenarioSpec>()
	readonly buildBuy = new Map<string, BuildBuyInput>()
	narrative: Narrative | undefined
	/** Assumption ids seeded from the profile, by profile key. */
	readonly profileIds = new Map<string, string>()
	/** Set by the participant wiring so the session can publish events; a no-op in pure unit tests. */
	emit: Emit = () => {}

	constructor(
		readonly state: RunState,
		private readonly now: () => Date = () => new Date(),
	) {}

	assumptions(): Assumption[] {
		return [...this.state.assumptions.values()] as unknown as Assumption[]
	}

	nextAssumptionId(): string {
		let n = this.state.assumptions.size + 1
		while (this.state.assumptions.has(`as_${String(n).padStart(3, "0")}`)) n++
		return `as_${String(n).padStart(3, "0")}`
	}

	profileFacts(): NonNullable<PlanInput["profile"]> {
		const p = (this.state.profile ?? {}) as Record<string, unknown>
		const out: NonNullable<PlanInput["profile"]> = {}
		if (p.risk_appetite === "low" || p.risk_appetite === "medium" || p.risk_appetite === "high") out.risk_appetite = p.risk_appetite
		if (Array.isArray(p.countries)) out.countries = p.countries as string[]
		const f = p.financials as Record<string, unknown> | undefined
		if (f) {
			const fin: NonNullable<PlanInput["profile"]>["financials"] = {}
			for (const k of ["cash_on_hand", "monthly_burn", "annual_revenue", "investable_budget"] as const) if (typeof f[k] === "number") fin[k] = f[k] as number
			out.financials = fin
		}
		return out
	}

	/** Cash before month 0, taken from the company profile when the model leaves it out. */
	defaultOpeningCash(): number {
		return this.profileFacts().financials?.cash_on_hand ?? 0
	}

	private currency(): string {
		const c = (this.state.profile as Record<string, unknown> | undefined)?.currency
		return typeof c === "string" ? c : "EUR"
	}

	/**
	 * The company's own revenue, cost and investable budget become assumptions before the model starts: origin "user"
	 * at 0.9 when stated, an explicit "default" placeholder otherwise. Idempotent. Returns the ids by profile key.
	 */
	seedProfile(): Map<string, string> {
		if (this.profileIds.size) return this.profileIds
		const f = ((this.state.profile as Record<string, unknown> | undefined)?.financials ?? {}) as Record<string, unknown>
		for (const fact of PROFILE_FACTS) {
			const stated = typeof f[fact.key] === "number" ? (f[fact.key] as number) * fact.scale : undefined
			const id = this.nextAssumptionId()
			const base = stated ?? 0
			const obj: Obj = {
				schema_version: "1.0",
				id,
				run_id: this.state.runId,
				text: stated === undefined ? `${fact.text} (not provided; placeholder 0)` : fact.text,
				unit: this.currency(),
				low: base * 0.85,
				base,
				high: base * 1.15,
				basis_finding_ids: [],
				origin: stated === undefined ? "default" : "user",
				confidence: stated === undefined ? 0.3 : 0.9,
			}
			assertValid("assumption", obj)
			this.state.assumptions.set(id, obj)
			this.profileIds.set(fact.key, id)
		}
		return this.profileIds
	}

	/** Validate, then store a scenario spec's three cases. Returns them plus the tornado for the spec. */
	computeSpec(spec: ScenarioSpec): { scenarios: Scenario[]; tornado: TornadoRow[] } {
		const cs = compileSpec(spec)
		const byId = indexAssumptions(this.assumptions())
		const opts = { runId: this.state.runId }
		const scenarios = (["base", "low", "high"] as const).map((c) => computeCompiled(cs, byId, { ...opts, case: c }))
		for (const s of scenarios) assertValid("scenario", s)
		this.specs.set(spec.id, spec)
		for (const s of scenarios) this.state.scenarios.set(s.id, s as unknown as Obj)
		return { scenarios, tornado: tornado(cs, this.assumptions(), 5) }
	}

	/**
	 * A "do nothing" baseline must always exist (root CLAUDE.md rule 9). When the Financial stage did not create one
	 * (stage token cap, timeout, model error), build an illustrative one from the company profile's own figures so the
	 * plan can still be assembled. Returns true when it had to.
	 */
	ensureBaseline(): boolean {
		if ([...this.specs.values()].some((s) => s.kind === "do_nothing")) return false
		const p = (this.state.profile ?? {}) as Record<string, unknown>
		const ids = this.seedProfile()
		this.computeSpec({
			id: "sc_baseline",
			name: "Do nothing (illustrative baseline from the company profile)",
			kind: "do_nothing",
			currency: this.currency(),
			years: typeof p.horizon_years === "number" ? p.horizon_years : 3,
			discount_rate: 0.1,
			contingency_pct: 0,
			opening_cash: this.defaultOpeningCash(),
			revenue: ids.get("annual_revenue")!,
			opex: ids.get("monthly_burn")!,
			notes: "Built by code from the company profile because the Financial stage produced no do_nothing scenario.",
		})
		return true
	}

	private planInput(): PlanInput {
		return {
			runId: this.state.runId,
			now: this.now(),
			assumptions: this.assumptions(),
			specs: [...this.specs.values()],
			findings: [...this.state.findings.values()],
			topics: [...this.state.topics.values()] as unknown as PlanInput["topics"],
			buildBuy: [...this.buildBuy.values()],
			profile: this.profileFacts(),
			...(this.narrative ? { narrative: this.narrative } : {}),
		}
	}

	/** The engine's current verdict without committing anything or emitting events (feeds the synthesizer's prompt). Null until a baseline exists. */
	preview(): PlanOutput | null {
		if (![...this.specs.values()].some((s) => s.kind === "do_nothing")) return null
		return assemblePlan(this.planInput())
	}

	/**
	 * Recompute everything from the current assumptions (including dashboard overrides) and rebuild the plan.
	 * Pure engine work - no LLM - so it is safe to call on every edit. Returns null until a do_nothing baseline exists.
	 */
	recompute(): PlanOutput | null {
		const out = this.preview()
		if (!out) return null
		assertValid("business_plan", out.plan)
		for (const s of out.scenarios) assertValid("scenario", s)

		// Commit only after everything validated.
		for (const s of out.scenarios) this.state.scenarios.set(s.id, s as unknown as Obj)
		const ranks = rankAssumptions([...this.specs.values()], this.assumptions())
		for (const [id, rank] of ranks) {
			const a = this.state.assumptions.get(id)
			if (a) a.sensitivity_rank = rank
		}
		this.state.plan = out.plan as unknown as Obj
		for (const s of out.scenarios) this.emit("scenario.computed", { id: s.id })
		this.emit("plan.ready", { id: this.state.runId })
		return out
	}
}
