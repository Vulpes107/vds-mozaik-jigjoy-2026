// Dynamic allocation rules (MASTERPLAN §4) as a plain function over the task board.
// No runtime, no LLM: `allocate` mutates the board it is given and returns the actions
// (events) the caller must emit. The participant in allocator-participant.ts is a thin shell.
import type { Budget, Slot } from "../shared/runtime.ts"
import {
	EV,
	type ReassignmentRequestedPayload,
	type ResearchGapPayload,
	type SlotIdlePayload,
	type SpendRecordedPayload,
	type TaskFinishedPayload,
	type TopicProgressPayload,
	type TopicScoredPayload,
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
}

export const defaultConfig: AllocatorConfig = {
	dropBelow: 0.3,
	reopenAbove: 0.35,
	deepImpact: 0.4,
	closeConfidence: 0.8,
	marginalDelta: 0.02,
	marginalSteps: 3,
	minDwellMs: 30_000,
	maxReassignments: 5,
	warnAt: 0.8,
	taskTimeoutMs: 420_000, // above research's own per-task limits (<= 360 s), so workers time themselves out first
}

export type Action =
	| { type: typeof EV.TopicStateChanged; topicId: string; from: TopicState; to: TopicState; reason: string }
	| { type: typeof EV.TopicDropped; topicId: string; reason: string }
	| { type: typeof EV.TaskAssigned; slotId: string; role: WorkerRole; topicId: string; fromTopicId?: string; handoff?: string }
	| { type: typeof EV.BudgetWarning; line: keyof Budget; used: number; limit: number }
	| { type: typeof EV.BudgetExhausted; line: keyof Budget; used: number; limit: number }
	| { type: typeof EV.AnalysisRequested; unresolvedTopicIds: string[]; droppedTopicIds: string[] }

export interface Incoming {
	type: string
	payload: unknown
}

const LIVE: TopicState[] = ["queued", "scouting", "deep", "shallow"]
const ROLES_NEEDED: Record<string, WorkerRole[]> = {
	queued: ["scout"],
	scouting: ["scout"],
	shallow: ["analyst"],
	deep: ["collector", "analyst", "verifier"],
}

// Per-board scratch state that is not part of the Topic contract.
const history = new WeakMap<Board, { confidence: Map<string, number[]>; rolesDone: Map<string, Set<WorkerRole>>; warned: Set<string>; analysisRequested: boolean }>()
function scratch(board: Board) {
	let s = history.get(board)
	if (!s) history.set(board, (s = { confidence: new Map(), rolesDone: new Map(), warned: new Set(), analysisRequested: false }))
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
	const freedFrom = new Map<string, string>()
	const free = (slotId: string, fromTopicId: string | null) => {
		const s = board.slots.get(slotId)
		if (!s) return
		if (s.topicId) freedFrom.set(slotId, s.topicId)
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
			if (p.relevance < cfg.dropBelow) {
				setState(t, "dropped", `relevance ${p.relevance} < ${cfg.dropBelow}: ${p.rationale}`)
				freeAllOn(t.id)
			} else if (p.impact < cfg.deepImpact) {
				setState(t, "shallow", `impact ${p.impact} < ${cfg.deepImpact}: ${p.rationale}`)
			} else {
				setState(t, "deep", `impact ${p.impact} >= ${cfg.deepImpact}: ${p.rationale}`)
			}
			// The scout's job is done either way; its slot moves on.
			for (const [id, s] of board.slots) if (s.topicId === t.id && s.role === "scout") free(id, t.id)
			break
		}
		case EV.TaskFinished: {
			const p = event.payload as TaskFinishedPayload
			const t = topic(p.topicId)
			// A late finish for a topic this slot already left must not free the slot's new assignment.
			if (board.slots.get(p.slotId)?.topicId === p.topicId) free(p.slotId, p.topicId)
			if (!t || !LIVE.includes(t.state)) break
			if (p.role === "scout" && (t.state === "queued" || t.state === "scouting")) {
				retry(t, "scout finished without scoring")
				break
			}
			if (p.outcome && p.outcome !== "done") {
				retry(t, `${p.role} ${p.outcome}`)
				break
			}
			const done = sc.rolesDone.get(t.id) ?? new Set<WorkerRole>()
			done.add(p.role)
			sc.rolesDone.set(t.id, done)
			if ((ROLES_NEEDED[t.state] ?? []).every((r) => done.has(r))) {
				setState(t, "closed", "all required roles finished")
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
			const hasFindings = [...(board.findings?.values() ?? [])].some((f) => f.topic_id === t.id)
			if (hasFindings) {
				// Partial evidence beats none: record the gap, keep the findings and the workers.
				t.state_reason = `gap: ${p.reason}`
			} else {
				setState(t, "research_incomplete", p.reason)
				freeAllOn(t.id)
			}
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
		case EV.AllocatorTick: {
			if (board.startedAt !== undefined) board.spent.seconds = Math.floor((now - board.startedAt) / 1000)
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

	// Budgets: hard limits. Exhaustion ends research; the unresolved list goes to the plan.
	let exhausted = false
	for (const k of ["tokens", "calls", "usd", "seconds"] as const) {
		const limit = board.runBudget[k]
		if (!limit) continue
		const used = board.spent[k]
		if (used >= limit) {
			exhausted = true
			if (!sc.warned.has(`x:${k}`)) {
				sc.warned.add(`x:${k}`)
				out.push({ type: EV.BudgetExhausted, line: k, used, limit })
			}
		} else if (used >= limit * cfg.warnAt && !sc.warned.has(k)) {
			sc.warned.add(k)
			out.push({ type: EV.BudgetWarning, line: k, used, limit })
		}
	}

	// Fill idle slots: highest priority topic that still wants this slot's role.
	if (!exhausted) {
		for (const [slotId, s] of board.slots) {
			if (s.topicId !== null || s.reassignments >= cfg.maxReassignments) continue
			const candidates = [...board.topics.values()]
				.filter((t) => LIVE.includes(t.state))
				.filter((t) => (ROLES_NEEDED[t.state] ?? []).includes(s.role))
				.filter((t) => !sc.rolesDone.get(t.id)?.has(s.role))
				.filter((t) => ![...board.slots.values()].some((o) => o.topicId === t.id && o.role === s.role))
				.map((t) => ({ t, p: priority(t, assignedTo(t.id)) }))
				.sort((a, b) => b.p - a.p)
			const pick = candidates[0]?.t
			if (!pick) continue
			const from = freedFrom.get(slotId)
			s.topicId = pick.id
			s.assignedAt = now
			pick.assigned_agents = [...(pick.assigned_agents ?? []), slotId]
			pick.priority = candidates[0]!.p
			if (pick.state === "queued") setState(pick, "scouting", "scout assigned")
			if (from && from !== pick.id) {
				s.reassignments++
				pick.reassignment_count = (pick.reassignment_count ?? 0) + 1
			}
			out.push({ type: EV.TaskAssigned, slotId, role: s.role, topicId: pick.id, fromTopicId: from, handoff: pick.state_reason })
		}
	}

	// Stop condition: nothing live and nothing running, or budget gone.
	const live = [...board.topics.values()].filter((t) => LIVE.includes(t.state))
	const busy = [...board.slots.values()].some((s) => s.topicId !== null)
	if (!sc.analysisRequested && board.topics.size > 0 && (exhausted || (live.length === 0 && !busy))) {
		sc.analysisRequested = true
		out.push({
			type: EV.AnalysisRequested,
			unresolvedTopicIds: [...board.topics.values()].filter((t) => LIVE.includes(t.state) || t.state === "research_incomplete").map((t) => t.id),
			droppedTopicIds: [...board.topics.values()].filter((t) => t.state === "dropped").map((t) => t.id),
		})
	}
	return out
}
