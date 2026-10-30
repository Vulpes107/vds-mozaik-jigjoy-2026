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
	/** Worker (B) reports confidence/progress on its topic; Allocator applies it to the Topic. */
	TopicProgress: "topic.progress",
	/** Analyst (B) proposes a new topic; Planner scores it before it can enter the board. */
	TopicSuggested: "topic.suggested",
	/** Worker (B) hit a research gap (provider outage, blocked pages); Allocator may mark the topic research_incomplete. */
	ResearchGap: "research.gap",
	/** Worker asks to be moved off its topic (stuck, nothing left to find). */
	ReassignmentRequested: "reassignment.requested",
	/** Dashboard edit (via A's API) of Assumption.user_override; analysis (C) recomputes without an LLM. */
	AssumptionOverridden: "assumption.overridden",
	/** Meter (A) turns inference.completed token usage into run spend; Allocator is the only writer of RunState.spent. */
	SpendRecorded: "spend.recorded",
	/** Periodic clock from the run (A): task timeouts, wall-clock budget, stuck-run detection. */
	AllocatorTick: "allocator.tick",
} as const

export type EventType = (typeof EV)[keyof typeof EV]

export type WorkerRole = "scout" | "collector" | "analyst" | "verifier"

export interface TopicScoredPayload {
	topicId: string
	relevance: number
	impact: number
	rationale: string
	evidenceQuality?: "none" | "thin" | "adequate"
	searches?: number
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

export interface TopicProgressPayload {
	topicId: string
	slotId: string
	confidence?: number
	progress?: number
	/** Cost delta since the last report; Allocator adds it to run and topic spend. */
	spent?: { tokens?: number; calls?: number; usd?: number; seconds?: number }
}

export interface TaskFinishedPayload {
	slotId: string
	topicId: string
	role: WorkerRole
	/** Anything but "done" means the task produced no trustworthy result; the Allocator retries the role. */
	outcome?: "done" | "budget_exhausted" | "timeout" | "error"
	summary?: string
	findings?: number
	sources?: number
}

export interface SlotIdlePayload {
	slotId: string
}

export interface TopicSuggestedPayload {
	title: string
	question: string
	category: string
	rationale: string
	/** Topic the suggestion came out of. */
	fromTopicId: string
}

export interface ResearchGapPayload {
	topicId: string
	slotId: string
	reason: string
}

export interface ReassignmentRequestedPayload {
	slotId: string
	topicId: string
	reason: string
}

export interface AssumptionOverriddenPayload {
	assumptionId: string
	/** null clears the override. */
	value: number | null
}

export interface SpendRecordedPayload {
	agentId: string
	model: string
	tokens: number
	usd: number
}

export interface IdPayload {
	id: string
}
