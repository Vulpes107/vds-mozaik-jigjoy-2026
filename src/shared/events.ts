// Custom Mozaik events for the research swarm. Built-in events (message.sent,
// inference.*, model.answer, ...) come from @mozaik-ai/core; these ride on sendEvent().
// Payloads reference contract objects by id; full objects live in RunState.

export const EV = {
	RunStarted: "run.started",
	RunCompleted: "run.completed",
	TopicsProposed: "topics.proposed",
	TopicApproved: "topic.approved",
	/** Scout reports relevance/impact for a topic. */
	TopicScored: "topic.scored",
	TopicStateChanged: "topic.state_changed",
	TopicDropped: "topic.dropped",
	/** Allocator tells a worker slot to start (or switch to) a topic. */
	TaskAssigned: "task.assigned",
	TaskFinished: "task.finished",
	SlotIdle: "slot.idle",
	FindingSubmitted: "finding.submitted",
	SourceSubmitted: "source.submitted",
	ConflictDetected: "conflict.detected",
	InjectionFlagged: "injection.flagged",
	BudgetWarning: "budget.warning",
	BudgetExhausted: "budget.exhausted",
	AnalysisRequested: "analysis.requested",
	ScenarioComputed: "scenario.computed",
	PlanReady: "plan.ready",
	CheckpointRequested: "checkpoint.requested",
	CheckpointResolved: "checkpoint.resolved",
} as const

export type EventType = (typeof EV)[keyof typeof EV]

export type WorkerRole = "scout" | "collector" | "analyst" | "verifier"

export interface TopicScoredPayload {
	topicId: string
	relevance: number
	impact: number
	rationale: string
}

export interface TaskAssignedPayload {
	/** Stable logical worker slot (survives reassignment); the Mozaik Agent is created fresh per task. */
	slotId: string
	role: WorkerRole
	topicId: string
	/** Topic the slot came from, when this is a reassignment. */
	fromTopicId?: string
	/** Short handoff note so a fresh agent starts with useful context. */
	handoff?: string
}

export interface TopicStateChangedPayload {
	topicId: string
	from: string
	to: string
	reason: string
}

export interface IdPayload {
	id: string
}
