// Scripted ~90-second demo run for the mock server (MOCK_DEMO=1).
//
// Start run -> Approve topics -> agents spawn -> a topic is dropped and its agent moves -> findings arrive (one conflict)
// -> one topic cannot be finished -> plan appears ~30 s after Approve. Editing an assumption then recomputes the
// scenarios with a small illustrative model, so the page visibly redraws and the verdict can flip.
//
// Everything here is illustrative fixture data (not engine output); the real recompute lives in src/analysis/.
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const mockDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "mocks")
const load = (n) => JSON.parse(readFileSync(join(mockDir, `${n}.json`), "utf8"))
const RUN = "r_demo1"

const TOPICS = [
	["t_001", "Competitor pricing for comparable products", "pricing", 0.8, "Top 5 competitors, comparable plans"],
	["t_002", "Trade show calendar in unrelated region", "channels", 0.3, undefined],
	["t_003", "Route-optimisation vendors: build vs buy", "technology", 0.75, "Total cost of ownership over 3 years"],
	["t_004", "Regulator guidance on data residency", "regulation", 0.7, undefined],
	["t_005", "Driver labour cost trends", "talent", 0.55, undefined],
]
const AGENTS = [
	["a_01", "scout", "t_001"],
	["a_02", "collector", "t_001"],
	["a_03", "scout", "t_002"],
	["a_04", "analyst", "t_003"],
	["a_05", "collector", "t_005"],
	["a_06", "verifier", "t_004"],
]
const SOURCES = [
	["s_001", "https://example.com/pricing", "Example Corp pricing", "Example Corp", "vendor", 0.7],
	["s_002", "https://example.org/benchmarks", "Logistics SaaS price benchmark", "Example Research", "analyst_report", 0.75],
	["s_003", "https://example.net/route-vendor-a", "Route optimisation vendor A: build cost study", "Vendor A", "vendor", 0.55],
	["s_004", "https://example.io/in-house-routing", "In-house routing engine post-mortem", "Example Engineering Blog", "blog", 0.45],
]
const FINDINGS = [
	["f_001", "t_001", "Example Corp's entry plan costs 49 EUR per user per month.", "fact", 49, "EUR/user/month", ["s_001"], 0.8],
	["f_002", "t_001", "Comparable plans from other vendors range from 39 to 59 EUR per user per month.", "estimate", 49, "EUR/user/month", ["s_002", "s_001"], 0.7],
	["f_003", "t_003", "Building route optimisation in-house is estimated at 260,000 EUR over three years.", "estimate", 260000, "EUR", ["s_003"], 0.55],
	["f_004", "t_003", "A comparable in-house build cost about 210,000 EUR over three years.", "estimate", 210000, "EUR", ["s_004"], 0.45],
	["f_005", "t_005", "Driver labour cost has risen about 6% per year over the last three years.", "estimate", 0.06, "ratio/yr", ["s_002"], 0.6],
]

// ---- illustrative recompute model --------------------------------------------------------------------------
const BASE = { price: 49, churn: 0.06 }
const eff = (a) => a.user_override ?? a.base
/** Revenue moves with retained users (churn). Only the new offer is priced, and volume gives back half of any price change. */
const factor = (price, churn, priced) => (priced ? 1 + 0.5 * (price / BASE.price - 1) : 1) * ((1 - churn) / (1 - BASE.churn)) ** 1.5
const pv = (arr, r) => arr.reduce((s, v, i) => s + v / (1 + r) ** (i + 1), 0)
function cashMin(sc, opening, rev) {
	const lift = 1 + (sc.contingency_pct ?? 0) / 100
	const at = new Map((sc.tranches?.length ? sc.tranches : sc.capex ? [{ month: 0, amount: sc.capex }] : []).map((t) => [t.month, t.amount * lift]))
	let cash = opening
	let min = opening
	for (let m = 1; m <= rev.length * 12; m++) {
		const y = Math.floor((m - 1) / 12)
		cash += ((rev[y] ?? 0) - (sc.opex_by_year[y] ?? 0)) / 12
		cash -= at.get(m) ?? 0
		min = Math.min(min, cash)
	}
	return min
}

export function createDemo(ctx) {
	const { topics, findings, sources, assumptions, scenarios, checkpoints, broadcast, setPlan, profile } = ctx
	const baseScenarios = load("scenario.sample")
	const basePlan = load("business_plan.sample")
	const baseAssumptions = load("assumption.sample")
	const speed = Number(process.env.DEMO_SPEED ?? 1)
	let seq = 0
	let timers = []
	let spentUsd = 0
	let status = "awaiting_checkpoint"

	const emit = (type, fields = {}) => broadcast({ schema_version: "1.0", seq: ++seq, ts: new Date().toISOString(), run_id: RUN, type, ...fields })
	const at = (sec, fn) => timers.push(setTimeout(fn, (sec * 1000) / speed))

	function reset() {
		for (const t of timers) clearTimeout(t)
		timers = []
		seq = 0
		spentUsd = 0
		status = "awaiting_checkpoint"
		ctx.agentEvents.length = 0
		for (const m of [topics, findings, sources, assumptions, scenarios]) m.clear()
		setPlan(undefined)
		checkpoints.clear()
		checkpoints.set("cp_topics", { id: "cp_topics", kind: "topics", status: "pending" })
		for (const [id, title, category, importance_prior, question] of TOPICS)
			topics.set(id, { schema_version: "1.0", id, run_id: RUN, title, ...(question ? { question } : {}), category, state: "queued", importance_prior, assigned_agents: [], proposed_by: "planner", reassignment_count: 0 })
	}

	const setTopic = (id, patch) => Object.assign(topics.get(id), patch)
	const addFinding = (row) => {
		const [id, topic_id, claim, type, value, unit, source_ids, confidence] = row
		findings.set(id, { schema_version: "1.0", id, run_id: RUN, topic_id, claim, type, value, unit, as_of: new Date().toISOString().slice(0, 10), source_ids, confidence, verified: false, conflicts_with: [] })
		for (const sid of source_ids) {
			if (!sources.has(sid)) {
				const [, url, title, publisher, source_type, reliability] = SOURCES.find((s) => s[0] === sid)
				sources.set(sid, { schema_version: "1.0", id: sid, run_id: RUN, url, title, publisher, retrieved_at: new Date().toISOString(), tool: "extract", source_type, reliability, injection_flagged: false })
				emit("source_added", { ref_id: sid, detail: title })
			}
		}
		emit("finding_added", { ref_id: id, topic_id, agent_id: "a_02", agent_role: "collector", detail: claim })
	}

	function recompute(withPlan = true) {
		const price = eff(assumptions.get("as_001"))
		const churn = eff(assumptions.get("as_002"))
		const opening = profile.financials?.cash_on_hand ?? 0
		for (const base of baseScenarios) {
			const f = factor(price, churn, base.id === "sc_2")
			const rev = base.revenue_by_year.map((v) => v * f)
			const r = base.discount_rate ?? 0.1
			const npvOf = (rv, sc) => pv(rv.map((v, i) => v - sc.opex_by_year[i]), r) - sc.capex * (1 + (sc.contingency_pct ?? 0) / 100)
			const npv = (base.metrics.npv ?? 0) + (npvOf(rev, base) - npvOf(base.revenue_by_year, base))
			const minCash = (base.metrics.min_cash_balance ?? 0) + (cashMin(base, opening, rev) - cashMin(base, opening, base.revenue_by_year))
			scenarios.set(base.id, {
				...structuredClone(base),
				revenue_by_year: rev.map(Math.round),
				metrics: {
					...base.metrics,
					npv: Math.round(npv),
					min_cash_balance: Math.round(minCash),
					runway_breached: minCash < 0,
					payback_months: base.metrics.payback_months == null || npv <= 0 ? null : Math.round(base.metrics.payback_months / Math.max(0.5, f)),
				},
			})
		}
		const nothing = scenarios.get("sc_1").metrics.npv
		const expand = scenarios.get("sc_2")
		if (!withPlan) return { wins: true, price }
		const wins = expand.metrics.npv > nothing
		const gap = expand.metrics.npv - nothing
		const plan = structuredClone(basePlan)
		plan.generated_at = new Date().toISOString()
		plan.unresolved_topic_ids = [...topics.values()].filter((t) => t.state === "research_incomplete").map((t) => t.id)
		plan.dropped_topic_ids = [...topics.values()].filter((t) => t.state === "dropped").map((t) => t.id)
		plan.recommendations[0].finding_ids = ["f_001", "f_002"]
		plan.risks[0].finding_ids = []
		const d = plan.decisions.continue_vs_change
		if (wins) {
			plan.chosen_scenario_id = "sc_2"
			plan.executive_summary = `Liquidity first: the Expand case runs short of cash in year 1 without staged funding. Expansion beats doing nothing by about ${Math.round(gap / 1000)}k EUR, so we recommend a staged expansion gated on pilot traction.`
		} else {
			plan.chosen_scenario_id = "sc_1"
			d.verdict = "continue"
			d.scores = { continue: 0.62, optimise: 0.5, expand: 0.34, pivot: 0.2, exit: 0.1 }
			d.rationale = "At this price the expansion no longer beats doing nothing."
			plan.executive_summary = `At a price of ${Number(price.toPrecision(3))} EUR the expansion is worth about ${Math.round(-gap / 1000)}k EUR less than doing nothing. Recommend continuing as is and revisiting when pricing evidence improves.`
			plan.risks = plan.risks.filter((r) => r.category !== "liquidity")
			plan.decisions.investment = { currency: "EUR", low: 0, base: 0, high: 0, staged: false, rationale: "No new investment while doing nothing is the better option." }
			plan.roadmap = [{ month: 0, milestone: "Keep operating as today", gate: false }, { month: 6, milestone: "Re-check price evidence", gate: true, kill_criteria: ["Price evidence above 45 EUR per user per month"] }]
		}
		plan.overall_confidence = 0.55
		setPlan(plan)
		return { wins, price }
	}

	function start() {
		if (status !== "awaiting_checkpoint") return
		status = "researching"
		const cp = checkpoints.get("cp_topics")
		cp.status = "approved"
		emit("topic_approved", { ref_id: "cp_topics", detail: "Topic list approved by the user" })
		AGENTS.forEach(([id, role, topic], i) => {
			at(0.4 + i * 0.3, () => {
				emit("agent_spawned", { agent_id: id, agent_role: role })
				emit("agent_assigned", { agent_id: id, agent_role: role, topic_id: topic })
				setTopic(topic, { state: "scouting", assigned_agents: [...topics.get(topic).assigned_agents, id] })
			})
		})
		at(4, () => {
			for (const [id, relevance, impact, state] of [["t_001", 0.9, 0.85, "deep"], ["t_003", 0.85, 0.7, "deep"], ["t_004", 0.8, 0.6, "deep"], ["t_005", 0.6, 0.3, "shallow"]]) {
				setTopic(id, { relevance, impact, state, priority: Math.round(impact * (1 - 0.4) * 100) / 100 })
				emit("topic_state_changed", { topic_id: id, detail: `Scout: relevance ${relevance.toFixed(2)}, impact ${impact.toFixed(2)}, so ${state}` })
			}
		})
		at(6, () => addFinding(FINDINGS[0]))
		at(8.5, () => spend(0.25))
		// The hero moment: an irrelevant topic is dropped and its worker moves to the topic where it helps most.
		at(9, () => {
			setTopic("t_002", { state: "dropped", relevance: 0.12, impact: 0.1, state_reason: "Scout found no link to the company's markets (relevance 0.12).", assigned_agents: [] })
			emit("topic_dropped", { agent_id: "a_03", agent_role: "scout", topic_id: "t_002", detail: "Relevance 0.12 below drop threshold 0.3" })
		})
		at(10, () => {
			const t = setTopic("t_001", { assigned_agents: [...topics.get("t_001").assigned_agents, "a_03"] })
			t.reassignment_count++
			emit("agent_reassigned", { agent_id: "a_03", agent_role: "collector", from_topic_id: "t_002", topic_id: "t_001", detail: "Highest priority topic (0.51)" })
		})
		at(12, () => addFinding(FINDINGS[1]))
		at(14, () => {
			addFinding(FINDINGS[2])
			addFinding(FINDINGS[3])
			findings.get("f_003").conflicts_with = ["f_004"]
			findings.get("f_004").conflicts_with = ["f_003"]
			emit("conflict_detected", { topic_id: "t_003", ref_id: "f_003", detail: "Two sources disagree on build cost: 260k vs 210k EUR. Verifier added." })
		})
		at(16, () => addFinding(FINDINGS[4]))
		at(17, () => {
			findings.get("f_001").verified = true
			findings.get("f_001").verified_by = "a_06"
			emit("finding_verified", { agent_id: "a_06", agent_role: "verifier", ref_id: "f_001", topic_id: "t_001", detail: "Confirmed by a second independent source" })
			spend(0.35)
		})
		at(18, () => {
			setTopic("t_001", { confidence: 0.7, priority: 0.26 })
			setTopic("t_003", { confidence: 0.55, priority: 0.32 })
			emit("topic_state_changed", { topic_id: "t_001", detail: "Confidence 0.70" })
			emit("topic_state_changed", { topic_id: "t_003", detail: "Confidence 0.55 (sources conflict)" })
		})
		at(20, () => {
			setTopic("t_004", { state: "research_incomplete", confidence: 0.2, state_reason: "Search provider outage after 3 retries; regulator site blocked.", assigned_agents: [] })
			emit("topic_state_changed", { topic_id: "t_004", detail: "Research incomplete: search provider outage after 3 retries" })
			emit("agent_idle", { agent_id: "a_06", agent_role: "verifier", detail: "No topic left to verify" })
		})
		at(22, () => {
			for (const id of ["t_001", "t_003", "t_005"]) setTopic(id, { state: "closed", state_reason: "Enough evidence collected for the decision.", assigned_agents: [] })
			setTopic("t_005", { confidence: 0.6 })
			emit("topic_state_changed", { topic_id: "t_005", detail: "Closed (shallow, confidence 0.60)" })
			spend(0.3)
		})
		at(24, () => emit("analysis_started", { detail: "Financial modeler, build-vs-buy, red team" }))
		at(26, () => {
			for (const a of baseAssumptions) assumptions.set(a.id, { ...structuredClone(a), basis_finding_ids: a.id === "as_001" ? ["f_001", "f_002"] : ["f_005"], origin: "research", confidence: a.id === "as_001" ? 0.7 : 0.6 })
			recompute(false)
			emit("scenario_computed", { ref_id: "sc_1", detail: "Do nothing" })
			emit("scenario_computed", { ref_id: "sc_2", detail: "Expand" })
		})
		at(29, () => {
			recompute()
			status = "done"
			emit("plan_ready", { detail: "Business plan assembled" })
			emit("run_completed", { detail: "Plan ready" })
		})
	}
	function spend(usd) {
		spentUsd += usd
	}

	/** Called after an override has been stored on the assumption. Emits like the real analysis would. */
	function onOverride() {
		if (status !== "done") return
		const { wins } = recompute()
		emit("scenario_computed", { ref_id: wins ? "sc_2" : "sc_1", detail: "Recomputed after an assumption edit" })
	}

	reset()
	return {
		start,
		reset,
		onOverride,
		status: () => status,
		spent: () => ({ usd: Math.round(spentUsd * 100) / 100, seconds: Math.round(seq * 3) }),
		recompute,
	}
}
