// Types shared inside Machine B. Contract objects stay loosely typed (see src/shared/runtime.ts) and are
// validated against /contracts at every write.
import type { WorkerRole } from "../shared/events.ts"

export type SourceType = "primary" | "regulator" | "filing" | "vendor" | "news" | "analyst_report" | "blog" | "forum" | "other"
export type SourceTool = "search" | "extract" | "map" | "crawl" | "research" | "manual"
export type FindingType = "fact" | "estimate" | "opinion"

export interface Clock {
	now(): Date
}
export const systemClock: Clock = { now: () => new Date() }

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10)

/** Payload of EV.TaskFinished, sent by the slot worker. The shared events file does not type it yet. */
export interface TaskFinishedPayload {
	slotId: string
	role: WorkerRole
	topicId: string
	outcome: "done" | "budget_exhausted" | "timeout" | "error"
	summary?: string
	findings: number
	sources: number
}

/** EV.TopicScored payload as sent by Scout: the shared fields plus how much evidence backed the scores. */
export interface ScoutScoredPayload {
	topicId: string
	relevance: number
	impact: number
	rationale: string
	evidenceQuality: "none" | "thin" | "adequate"
	searches: number
}

/** EV.InjectionFlagged payload: `id` is the Source id, so a consumer that only reads IdPayload still works. */
export interface InjectionFlaggedPayload {
	id: string
	url: string
	topicId?: string
	slotId?: string
	patterns: string[]
}

export interface ConflictPayload {
	id: string
	conflictsWith: string
	topicId: string
}

/** Where a tool call comes from; carried into the gateway for budgets, metering and gap reporting. */
export interface CallContext {
	slotId: string
	topicId: string
	/** Topic category, used for redaction policy (brand topics may name the company) and freshness. */
	category?: string
	depth?: "shallow" | "deep"
	/** Records a research gap for this task (deduplicated by the scope). */
	recordGap(reason: string): void
}
