// Dynamic allocation rules (MASTERPLAN §4) as a plain function over the task board.
// No runtime, no LLM: `allocate` mutates the board it is given and returns the actions
// (events) the caller must emit. The participant in allocator-participant.ts is a thin shell.
import type { Budget, Slot } from "../shared/runtime.ts"
import {
	EV,
	type ReassignmentRequestedPayload,
	type ReplanRequestedPayload,
	type ResearchGapPayload,
	type SlotIdlePayload,
	type SpendRecordedPayload,
	type TaskFinishedPayload,
	type TopicProgressPayload,
	type TopicScoredPayload,
	type TopicsProposedPayload,
	type WorkerRole,
} from "../shared/events.ts"

export type TopicState = "queued" | "scouting" | "deep" | "shallow" | "closed" | "dropped" | "research_incomplete"

/** The Topic contract fields the allocator reads/writes (others pass through untouched). */
export interface Topic {
	id: string
	state: TopicState
	state_reason?: string
	importance_prior: number
	relevance?: number
	impact?: number
	confidence?: number
	priority?: number
	assigned_agents?: string[]
	reassignment_count?: number
	spent?: Budget
	updated_at?: string
	[k: string]: unknown
}

export interface Board {
	topics: Map<string, Topic>
	slots: Map<string, Slot>
	runBudget: Budget
	spent: Required<Budget>
	startedAt?: number
	/** RunState.findings; a research gap only ends a topic that has none. */
	findings?: Map<string, { topic_id?: unknown }>
}

export interface AllocatorConfig {
	dropBelow: number
	/** Hysteresis: a dropped topic reopens only when re-scored above this. */
	reopenAbove: number
	deepImpact: number
	/** Close a topic once confidence reaches this. */
	closeConfidence: number
	/** A deep topic whose first collector->analyst->verifier pass ends below this gets one more pass while the research budget has a topic's worth left. */
	secondPassBelow: number
	/** Close early when the last `marginalSteps` confidence deltas are all below this. */
	marginalDelta: number
	marginalSteps: number
	/** A slot is not moved off a live topic before this many ms. */
	minDwellMs: number
	maxReassignments: number
	/** Fraction of any budget line that triggers budget.warning. */
	warnAt: number
	/** A slot busy longer than this (no task.finished) is freed and its topic retried. */
	taskTimeoutMs: number
	/** Share of each budget line kept for the analysis stages, which run after research: max(fraction x limit, absolute), never more than half. */
	analysisReserve: { fraction: number; usd: number; seconds: number; tokens: number }
	/** Planning estimate per deep topic (collector+analyst+verifier trio); sizes the agenda and decides whether leftover budget buys another round. */
	topicCost: { usd: number; seconds: number }
	/** Follow-up planning rounds when every topic is done and at least one topic's worth of research budget is left. 0 disables. */
	maxReplanRounds: number
}

export const defaultConfig: AllocatorConfig = {
	dropBelow: 0.3,
	reopenAbove: 0.35,
	deepImpact: 0.4,
	closeConfidence: 0.8,
	secondPassBelow: 0.6, // the 2026-10-31 run closed every deep topic at 0.3-0.43 after one pass, with 2.5 USD unspent
	marginalDelta: 0.02,
	marginalSteps: 3,
	minDwellMs: 30_000,
	maxReassignments: 5,
	warnAt: 0.8,
	taskTimeoutMs: 420_000, // above research's own per-task limits (<= 360 s), so workers time themselves out first
	analysisReserve: { fraction: 0.25, usd: 0.75, seconds: 240, tokens: 300_000 }, // the 2026-10-31 live run: analysis took 0.57 USD and 150 s after research stopped
	// Live runs on 2026-10-31 (Haiku workers) measured ~0.3 USD / ~1 min per topic with staged roles. Set at that measurement
	// (was 0.45 / 150, which left a third of a 5 USD run unspent); overruns end as research_incomplete, so erring low is safe.
	topicCost: { usd: 0.3, seconds: 100 },
	maxReplanRounds: 3,
}

/** The part of one budget line research may spend; the rest is kept for analysis. Search calls are research-only, so no reserve. */
export function researchLimit(line: keyof Budget, limit: number, cfg: AllocatorConfig = defaultConfig): number {
	const abs = line === "calls" ? 0 : cfg.analysisReserve[line]
	if (!abs) return limit
	return limit - Math.min(Math.max(cfg.analysisReserve.fraction * limit, abs), limit / 2)
}
export function researchBudget(b: Budget, cfg: AllocatorConfig = defaultConfig): Budget {
	return Object.fromEntries((Object.entries(b) as [keyof Budget, number | undefined][]).filter(([, v]) => v !== undefined).map(([k, v]) => [k, researchLimit(k, v!, cfg)]))
}

/** Research budget still unspent on the lines the run limits, or undefined when it is not enough for `topics` more topics' worth. */
export function replanBudget(board: Board, cfg: AllocatorConfig = defaultConfig, topics = 1): ReplanRequestedPayload["remaining"] | undefined {
	const r: ReplanRequestedPayload["remaining"] = {}
	for (const k of ["usd", "seconds"] as const) {
		const full = board.runBudget[k]
		if (!full) continue
		const left = researchLimit(k, full, cfg) - board.spent[k]
		if (left < cfg.topicCost[k] * topics) return undefined
		r[k] = left
	}
	return Object.keys(r).length ? r : undefined
}

export type Action =
	| { type: typeof EV.TopicStateChanged; topicId: string; from: TopicState; to: TopicState; reason: string }
	| { type: typeof EV.TopicDropped; topicId: string; reason: string }
	| { type: typeof EV.TaskAssigned; slotId: string; role: WorkerRole; topicId: string; fromTopicId?: string; handoff?: string }
	| { type: typeof EV.BudgetWarning; line: keyof Budget; used: number; limit: number; reserved: number }
	| { type: typeof EV.BudgetExhausted; line: keyof Budget; used: number; limit: number; reserved: number }
	| { type: typeof EV.AnalysisRequested; unresolvedTopicIds: string[]; droppedTopicIds: string[] }
	| ({ type: typeof EV.ReplanRequested } & ReplanRequestedPayload)

export interface Incoming {
	type: string
	payload: unknown
}

const LIVE: TopicState[] = ["queued", "scouting", "deep", "shallow"]
/** Deep work is sequential: the analyst needs the collector's material, the verifier needs findings to check. */
const PRECEDES: Partial<Record<WorkerRole, WorkerRole>> = { analyst: "collector", verifier: "analyst" }
const ROLES_NEEDED: Record<string, WorkerRole[]> = {
	queued: ["scout"],
	scouting: ["scout"],
	shallow: ["analyst"],
	deep: ["collector", "analyst", "verifier"],
}

// Per-board scratch state that is not part of the Topic contract.
interface Scratch {
	confidence: Map<string, number[]>
	rolesDone: Map<string, Set<WorkerRole>>
	/** Topics that already had their second pass. */
	secondPass: Set<string>
	warned: Set<string>
	analysisRequested: boolean
	approved: boolean
	planReady: boolean
	/** Follow-up rounds requested so far, and when the pending one was asked for (undefined: none pending). */
	replans: number
	replanAskedAt?: number
}
const history = new WeakMap<Board, Scratch>()
function scratch(board: Board) {
	let s = history.get(board)
	if (!s) history.set(board, (s = { confidence: new Map(), rolesDone: new Map(), secondPass: new Set(), warned: new Set(), analysisRequested: false, approved: false, planReady: false, replans: 0 }))
	return s
}

export function priority(t: Topic, assigned: number): number {
	return (t.impact ?? t.importance_prior) * (1 - (t.confidence ?? 0)) / (1 + assigned)
}

/** Apply one event to the board. Returns the actions to emit, in order. Safe to call with events out of order or twice. */
export function allocate(board: Board, event: Incoming, cfg: AllocatorConfig = defaultConfig, now = Date.now()): Action[] {
	const out: Action[] = []
	const sc = scratch(board)
	const topic = (id: string) => board.topics.get(id)
	const assignedTo = (id: string) => [...board.slots.values()].filter((s) => s.topicId === id).length

	const setState = (t: Topic, to: TopicState, reason: string) => {
		if (t.state === to) return
		out.push({ type: EV.TopicStateChanged, topicId: t.id, from: t.state, to, reason })
		if (to === "dropped") out.push({ type: EV.TopicDropped, topicId: t.id, reason })
		t.state = to
		t.state_reason = reason
		t.updated_at = new Date(now).toISOString()
	}
	/** Where each slot freed this event came from (reported on the next assignment), and which of those were pulled off mid-work (the only moves counted against anti-thrash limits). */
	const movedFrom = new Map<string, string>()
	const preempted = new Set<string>()
	const free = (slotId: string, fromTopicId: string | null, midWork = true) => {
		const s = board.slots.get(slotId)
		if (!s) return
		if (s.topicId) {
			movedFrom.set(slotId, s.topicId)
			if (midWork) preempted.add(slotId)
		}
		s.topicId = null
		if (fromTopicId) {
			const t = topic(fromTopicId)
			if (t) t.assigned_agents = (t.assigned_agents ?? []).filter((a) => a !== slotId)
		}
	}
	const freeAllOn = (topicId: string) => {
		for (const [id, s] of board.slots) if (s.topicId === topicId) free(id, topicId)
	}
	/** Give a topic another go (back to the board) until it has been retried too often. */
	const retry = (t: Topic, reason: string) => {
		t.reassignment_count = (t.reassignment_count ?? 0) + 1
		if (t.reassignment_count > cfg.maxReassignments) setState(t, "research_incomplete", `${reason}; retries exhausted`)
		else if (t.state === "scouting") setState(t, "queued", `${reason}; retrying`)
		else t.state_reason = `${reason}; retrying`
	}

	switch (event.type) {
		case EV.TopicApproved: {
			sc.approved = true
			break
		}
		case EV.TopicScored: {
			const p = event.payload as TopicScoredPayload
			const t = topic(p.topicId)
			if (!t) break
			t.relevance = p.relevance
			t.impact = p.impact
			if (t.state === "dropped") {
				// Hysteresis: only new evidence clearly above the band reopens a dropped topic.
				if (p.relevance > cfg.reopenAbove) setState(t, "queued", `reopened on new evidence (relevance ${p.relevance})`)
				break
			}
			if (!LIVE.includes(t.state)) break
			// The scout's job is done either way; its slot moves on (not a reassignment).
			for (const [id, s] of board.slots) if (s.topicId === t.id && s.role === "scout") free(id, t.id, false)
			if (p.relevance < cfg.dropBelow) {
				setState(t, "dropped", `relevance ${p.relevance} < ${cfg.dropBelow}: ${p.rationale}`)
				freeAllOn(t.id)
			} else if (p.impact < cfg.deepImpact) {
				setState(t, "shallow", `impact ${p.impact} < ${cfg.deepImpact}: ${p.rationale}`)
			} else {
				setState(t, "deep", `impact ${p.impact} >= ${cfg.deepImpact}: ${p.rationale}`)
			}
			break
		}
		case EV.TaskFinished: {
			const p = event.payload as TaskFinishedPayload
			const t = topic(p.topicId)
			// A late finish for a topic this slot already left must not free the slot's new assignment.
			if (board.slots.get(p.slotId)?.topicId === p.topicId) free(p.slotId, p.topicId, false)
			if (!t || !LIVE.includes(t.state)) break
			if (p.role === "scout" && (t.state === "queued" || t.state === "scouting")) {
				retry(t, "scout finished without scoring")
				break
			}
			// A task that hit its own cap stopped cleanly with its findings submitted; a fresh agent would redo the same work for the same money.
			if (p.outcome && p.outcome !== "done" && p.outcome !== "budget_exhausted") {
				retry(t, `${p.role} ${p.outcome}`)
				break
			}
			// Produced nothing, the topic has no findings, and nobody else is working on it: there is nothing to pass on.
			const hasFindings = [...(board.findings?.values() ?? [])].some((f) => f.topic_id === t.id)
			const others = [...board.slots.values()].some((o) => o.topicId === t.id)
			if (p.role !== "scout" && p.findings === 0 && p.sources === 0 && !hasFindings && !others) {
				setState(t, "research_incomplete", t.state_reason?.startsWith("gap: ") ? t.state_reason.slice(5) : `${p.role} finished without producing output`)
				break
			}
			const done = sc.rolesDone.get(t.id) ?? new Set<WorkerRole>()
			done.add(p.role)
			sc.rolesDone.set(t.id, done)
			if ((ROLES_NEEDED[t.state] ?? []).every((r) => done.has(r))) {
				// A thin first pass gets one more round of the same roles instead of closing; the reason is the handoff note.
				// Only when the budget also covers every topic still waiting for its first pass: on 2026-10-31 second passes on two
				// 0.31-priority topics spent what four 0.6-0.7 topics needed, and those ended unstaffed.
				const waiting = [...board.topics.values()].filter((o) => o.id !== t.id && LIVE.includes(o.state)).length
				const thin = t.state === "deep" && (t.confidence ?? 0) < cfg.secondPassBelow && hasFindings && !sc.secondPass.has(t.id) && replanBudget(board, cfg, waiting + 1) !== undefined
				if (thin) {
					sc.secondPass.add(t.id)
					sc.rolesDone.delete(t.id)
					t.state_reason = `second pass: confidence ${t.confidence} < ${cfg.secondPassBelow} after one pass; find more independent, typed and recent sources for the thin claims`
				} else setState(t, "closed", "all required roles finished")
				freeAllOn(t.id)
			}
			break
		}
		case EV.SlotIdle: {
			const p = event.payload as SlotIdlePayload
			free(p.slotId, board.slots.get(p.slotId)?.topicId ?? null)
			break
		}
		case EV.TopicProgress: {
			const p = event.payload as TopicProgressPayload
			const t = topic(p.topicId)
			if (!t) break
			if (p.spent) {
				for (const k of ["tokens", "calls", "usd", "seconds"] as const) {
					board.spent[k] += p.spent[k] ?? 0
					t.spent = { ...t.spent, [k]: (t.spent?.[k] ?? 0) + (p.spent[k] ?? 0) }
				}
			}
			if (p.confidence === undefined || !LIVE.includes(t.state)) break
			const hist = sc.confidence.get(t.id) ?? []
			hist.push(p.confidence)
			sc.confidence.set(t.id, hist)
			t.confidence = p.confidence
			const verifierPending = t.state === "deep" && !sc.rolesDone.get(t.id)?.has("verifier")
			const recent = hist.slice(-cfg.marginalSteps - 1)
			const stalled = recent.length > cfg.marginalSteps && recent.every((c, i) => i === 0 || Math.abs(c - recent[i - 1]!) < cfg.marginalDelta)
			if (!verifierPending && t.state !== "queued" && t.state !== "scouting") {
				if (p.confidence >= cfg.closeConfidence) setState(t, "closed", `confidence ${p.confidence} >= ${cfg.closeConfidence}`)
				else if (stalled) setState(t, "closed", `marginal value below ${cfg.marginalDelta} for ${cfg.marginalSteps} steps`)
				if (t.state === "closed") freeAllOn(t.id)
			}
			break
		}
		case EV.ResearchGap: {
			const p = event.payload as ResearchGapPayload
			const t = topic(p.topicId)
			if (!t || !LIVE.includes(t.state)) break
			// A gap is a reason, not a verdict: the task reporting it is still running (one failed tool call need not end a topic).
			// The topic ends only when a task finishes with nothing and nobody else is on it (see task.finished).
			t.state_reason = `gap: ${p.reason}`
			break
		}
		case EV.ReassignmentRequested: {
			const p = event.payload as ReassignmentRequestedPayload
			const s = board.slots.get(p.slotId)
			if (s && now - s.assignedAt >= cfg.minDwellMs) free(p.slotId, s.topicId)
			break
		}
		case EV.SpendRecorded: {
			const p = event.payload as SpendRecordedPayload
			board.spent.tokens += p.tokens
			board.spent.usd += p.usd
			break
		}
		case EV.PlanReady: {
			sc.planReady = true // the run is over: the clock stops
			break
		}
		case EV.TopicsProposed: {
			// The Planner answered a replan request. An empty round means nothing left is worth the money.
			if (sc.replanAskedAt === undefined) break
			sc.replanAskedAt = undefined
			if (!(event.payload as TopicsProposedPayload).topicIds?.length) sc.replans = cfg.maxReplanRounds
			break
		}
		case EV.AllocatorTick: {
			if (board.startedAt !== undefined && !sc.planReady) board.spent.seconds = Math.floor((now - board.startedAt) / 1000)
			for (const [id, s] of board.slots) {
				if (s.topicId === null || now - s.assignedAt < cfg.taskTimeoutMs) continue
				const t = topic(s.topicId)
				free(id, s.topicId)
				if (t && LIVE.includes(t.state)) retry(t, `task on ${id} timed out after ${cfg.taskTimeoutMs} ms`)
			}
			// A topic whose next role no slot can ever serve would wait forever.
			const canServe = (role: WorkerRole) => [...board.slots.values()].some((s) => s.role === role && s.reassignments < cfg.maxReassignments)
			for (const t of board.topics.values()) {
				if (!LIVE.includes(t.state)) continue
				const missing = (ROLES_NEEDED[t.state] ?? []).filter((r) => !sc.rolesDone.get(t.id)?.has(r) && !canServe(r))
				if (missing.length) {
					setState(t, "research_incomplete", `no ${missing.join("/")} slot available`)
					freeAllOn(t.id)
				}
			}
			break
		}
	}

	// Budgets: hard limits. Research stops at its share (the rest is reserved for analysis); the unresolved list goes to the plan.
	let exhausted = false
	for (const k of ["tokens", "calls", "usd", "seconds"] as const) {
		const full = board.runBudget[k]
		if (!full) continue
		const limit = researchLimit(k, full, cfg)
		const reserved = full - limit
		const used = board.spent[k]
		if (used >= limit) {
			exhausted = true
			if (!sc.warned.has(`x:${k}`)) {
				sc.warned.add(`x:${k}`)
				out.push({ type: EV.BudgetExhausted, line: k, used, limit, reserved })
			}
		} else if (used >= limit * cfg.warnAt && !sc.warned.has(k)) {
			sc.warned.add(k)
			out.push({ type: EV.BudgetWarning, line: k, used, limit, reserved })
		}
	}

	// Fill idle slots: highest priority topic that still wants this slot's role. Never before the human approved the topic list.
	if (!exhausted && sc.approved) {
		for (const [slotId, s] of board.slots) {
			if (s.topicId !== null || s.reassignments >= cfg.maxReassignments) continue
			const candidates = [...board.topics.values()]
				.filter((t) => LIVE.includes(t.state))
				.filter((t) => (ROLES_NEEDED[t.state] ?? []).includes(s.role))
				.filter((t) => !sc.rolesDone.get(t.id)?.has(s.role))
				.filter((t) => t.state !== "deep" || !PRECEDES[s.role] || sc.rolesDone.get(t.id)?.has(PRECEDES[s.role]!))
				.filter((t) => ![...board.slots.values()].some((o) => o.topicId === t.id && o.role === s.role))
				.map((t) => ({ t, p: priority(t, assignedTo(t.id)) }))
				.sort((a, b) => b.p - a.p)
			const pick = candidates[0]?.t
			if (!pick) continue
			const from = movedFrom.get(slotId)
			s.topicId = pick.id
			s.assignedAt = now
			pick.assigned_agents = [...(pick.assigned_agents ?? []), slotId]
			pick.priority = candidates[0]!.p
			if (pick.state === "queued") setState(pick, "scouting", "scout assigned")
			if (from && from !== pick.id && preempted.has(slotId)) {
				s.reassignments++
				pick.reassignment_count = (pick.reassignment_count ?? 0) + 1
			}
			out.push({ type: EV.TaskAssigned, slotId, role: s.role, topicId: pick.id, fromTopicId: from, handoff: pick.state_reason?.slice(0, 200) })
		}
	}

	// Stop condition: nothing live and nothing running, or budget gone. With a topic's worth of research budget left,
	// ask the Planner for a follow-up round first (bounded by maxReplanRounds; a Planner that never answers is timed out).
	const live = [...board.topics.values()].filter((t) => LIVE.includes(t.state))
	const busy = [...board.slots.values()].some((s) => s.topicId !== null)
	const idle = live.length === 0 && !busy
	if (sc.replanAskedAt !== undefined && now - sc.replanAskedAt >= cfg.taskTimeoutMs) {
		sc.replanAskedAt = undefined
		sc.replans = cfg.maxReplanRounds
	}
	const remaining = !exhausted && idle && sc.approved && sc.replanAskedAt === undefined && sc.replans < cfg.maxReplanRounds ? replanBudget(board, cfg) : undefined
	if (!sc.analysisRequested && remaining) {
		sc.replans++
		sc.replanAskedAt = now
		out.push({ type: EV.ReplanRequested, remaining, round: sc.replans })
	} else if (!sc.analysisRequested && board.topics.size > 0 && (exhausted || (idle && sc.replanAskedAt === undefined))) {
		sc.analysisRequested = true
		// Research is over: a topic still live now did not finish, and its state must say so (the plan, the table and the counts all read it).
		for (const t of board.topics.values()) if (LIVE.includes(t.state)) setState(t, "research_incomplete", t.assigned_agents?.length ? "research budget exhausted before this topic finished" : "research budget exhausted before this topic was staffed")
		out.push({
			type: EV.AnalysisRequested,
			unresolvedTopicIds: [...board.topics.values()].filter((t) => t.state === "research_incomplete").map((t) => t.id),
			droppedTopicIds: [...board.topics.values()].filter((t) => t.state === "dropped").map((t) => t.id),
		})
	}
	return out
}
