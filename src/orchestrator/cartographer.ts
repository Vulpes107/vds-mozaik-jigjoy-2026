// Cartographer: code-only observer that maps runtime events to AgentEvent records for the dashboard.
// Appends to RunState.agentEvents (monotonic seq for SSE replay) and notifies live subscribers.
import { SituationSpecification, createHuman, type SemanticEvent, type SituationContext } from "@mozaik-ai/core"
import { EV, type TaskAssignedPayload } from "../shared/events.ts"
import { resolveRuntime, type Obj } from "../shared/runtime.ts"
import { validate } from "../shared/validate.ts"

type P = Record<string, unknown>

/** EV.* -> AgentEvent.type, plus the fields to lift out of the payload. */
const r2 = (n: unknown) => (typeof n === "number" ? Math.round(n * 100) / 100 : n)
const budgetLine = (p: Record<string, unknown>) => `${p.line}: ${r2(p.used)}/${r2(p.limit)} for research${(p.reserved as number) > 0 ? ` (${r2(p.reserved)} kept for analysis)` : ""}`

const MAP: Record<string, (p: P) => Partial<Obj> | null> = {
	[EV.RunStarted]: () => ({ type: "run_started" }),
	[EV.RunCompleted]: (p) => ({ type: "run_completed", detail: p.reason }),
	[EV.TopicsProposed]: (p) => ({ type: "topics_proposed", detail: `${(p.topicIds as string[])?.length ?? 0} topics` }),
	[EV.TopicApproved]: () => ({ type: "topic_approved" }),
	[EV.TopicStateChanged]: (p) => ({ type: "topic_state_changed", topic_id: p.topicId, detail: `${p.from} -> ${p.to}: ${p.reason}` }),
	[EV.TopicDropped]: (p) => ({ type: "topic_dropped", topic_id: p.topicId, detail: p.reason }),
	[EV.TaskAssigned]: (p) => {
		const a = p as unknown as TaskAssignedPayload
		return { type: a.fromTopicId ? "agent_reassigned" : "agent_assigned", agent_id: a.slotId, agent_role: a.role, topic_id: a.topicId, from_topic_id: a.fromTopicId, detail: a.handoff }
	},
	[EV.SlotIdle]: (p) => ({ type: "agent_idle", agent_id: p.slotId }),
	[EV.FindingSubmitted]: (p) => (p.updated ? null : { type: "finding_added", ref_id: p.id, topic_id: p.topicId }),
	[EV.SourceSubmitted]: (p) => ({ type: "source_added", ref_id: p.id, topic_id: p.topicId }),
	[EV.ConflictDetected]: (p) => ({ type: "conflict_detected", ref_id: p.id, topic_id: p.topicId, detail: p.detail }),
	[EV.InjectionFlagged]: (p) => ({ type: "injection_flagged", ref_id: p.id, topic_id: p.topicId, detail: p.detail }),
	[EV.BudgetWarning]: (p) => ({ type: "budget_warning", detail: budgetLine(p) }),
	[EV.BudgetExhausted]: (p) => ({ type: "budget_exhausted", detail: budgetLine(p) }),
	[EV.ReplanRequested]: (p) => {
		const r = p.remaining as Record<string, number>
		return { type: "replan_requested", detail: `round ${p.round}: ${Object.entries(r).map(([k, v]) => `${r2(v)} ${k}`).join(", ")} of research budget left` }
	},
	[EV.AnalysisRequested]: (p) => ({ type: "analysis_started", detail: `${(p.unresolvedTopicIds as string[])?.length ?? 0} unresolved` }),
	[EV.ScenarioComputed]: (p) => ({ type: "scenario_computed", ref_id: p.id }),
	[EV.PlanReady]: () => ({ type: "plan_ready" }),
	[EV.CheckpointRequested]: (p) => ({ type: "checkpoint_requested", ref_id: p.id, detail: p.kind }),
	[EV.CheckpointResolved]: (p) => ({ type: "checkpoint_resolved", ref_id: p.id, detail: p.approved ? "approved" : "rejected" }),
}

const listeners = new Set<(e: Obj) => void>()

/** Subscribe to live AgentEvents (SSE). Returns an unsubscribe function. */
export function onAgentEvent(fn: (e: Obj) => void): () => void {
	listeners.add(fn)
	return () => void listeners.delete(fn)
}

export function toAgentEvent(event: SemanticEvent, runId: string, seq: number): Obj | null {
	const map = MAP[event.type]
	if (!map) return null
	const mapped = map((event.payload ?? {}) as P)
	if (!mapped) return null
	const out: Obj = { schema_version: "1.0", seq, ts: event.occurredAt.toISOString(), run_id: runId, ...mapped } as Obj
	for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
	return out
}

class WhenMapped extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type in MAP
	}
}

export function makeCartographer() {
	return createHuman({
		name: "Cartographer",
		capabilities: ["observe"],
		handlers: [
			{
				specification: new WhenMapped(),
				processor: {
					apply: ({ event }) => {
						const state = resolveRuntime().state
						const e = toAgentEvent(event, state.runId, state.agentEvents.length)
						if (!e) return
						const err = validate("agent_event", e)
						if (err) {
							// Never let a bad mapping break the run; it is a bug to fix, not a stream to drop.
							console.error(`cartographer: invalid AgentEvent for ${event.type}: ${err}`)
							return
						}
						state.agentEvents.push(e)
						for (const fn of listeners) fn(e)
					},
				},
			},
		],
	})
}
