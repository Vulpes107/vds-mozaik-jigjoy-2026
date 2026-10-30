// Snapshot of RunState for crash recovery and the dashboard's run history, kept in SQLite (ADR 0002).
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Obj, RunState, Slot } from "../shared/runtime.ts"
import { openStore } from "./store.ts"

export interface Snapshot {
	runId: string
	savedAt: string
	profile?: Obj
	topics: Obj[]
	findings: Obj[]
	sources: Obj[]
	assumptions: Obj[]
	scenarios: Obj[]
	plan?: Obj
	slots: Record<string, Slot>
	agentEvents: Obj[]
	checkpoints: Obj[]
	runBudget: RunState["runBudget"]
	spent: RunState["spent"]
}

export function snapshot(s: RunState): Snapshot {
	return {
		runId: s.runId,
		savedAt: new Date().toISOString(),
		profile: s.profile,
		topics: [...s.topics.values()],
		findings: [...s.findings.values()],
		sources: [...s.sources.values()],
		assumptions: [...s.assumptions.values()],
		scenarios: [...s.scenarios.values()],
		plan: s.plan,
		slots: Object.fromEntries(s.slots),
		agentEvents: s.agentEvents,
		checkpoints: [...s.checkpoints.values()],
		runBudget: s.runBudget,
		spent: s.spent,
	}
}

/** Fill an empty RunState from a snapshot. Slots come back idle: the Allocator re-fills them on the next event. */
export function restore(s: RunState, snap: Snapshot): RunState {
	s.runId = snap.runId
	s.profile = snap.profile
	for (const [k, items] of [["topics", snap.topics], ["findings", snap.findings], ["sources", snap.sources], ["assumptions", snap.assumptions], ["scenarios", snap.scenarios], ["checkpoints", snap.checkpoints]] as const) {
		const map = s[k] as Map<string, Obj>
		for (const o of items) map.set(o.id, o)
	}
	for (const t of s.topics.values()) t.assigned_agents = []
	s.plan = snap.plan
	for (const [id, slot] of Object.entries(snap.slots)) s.slots.set(id, { ...slot, topicId: null })
	s.agentEvents = snap.agentEvents
	s.runBudget = snap.runBudget
	s.spent = snap.spent
	return s
}

export function runStatus(s: RunState): string {
	if (s.plan) return "done"
	if (s.agentEvents.some((e) => e.type === "run_completed")) return "stopped"
	if ([...s.checkpoints.values()].some((c) => c.status === "pending")) return "awaiting_checkpoint"
	if (s.agentEvents.some((e) => e.type === "analysis_started")) return "analysis"
	if (s.topics.size === 0) return "planning"
	return "researching"
}

/** Upsert the run's latest snapshot into `<dir>/mozaik.db`; returns the database path. */
export function writeSnapshot(s: RunState, dir = "data"): string {
	const snap = snapshot(s)
	openStore(dir).save(s.runId, snap.savedAt, { projectId: s.profile?.project_id as string | undefined, company: s.profile?.name as string | undefined, status: runStatus(s), spentUsd: s.spent.usd }, JSON.stringify(snap))
	return join(dir, "mozaik.db")
}

/** Reads the run from the database; falls back to a pre-ADR-0002 `<dir>/<runId>.json` file. */
export function readSnapshot(runId: string, dir = "data"): Snapshot {
	const stored = openStore(dir).load(runId)
	if (stored) return JSON.parse(stored) as Snapshot
	const legacy = join(dir, `${runId}.json`)
	if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, "utf8")) as Snapshot
	throw new Error(`no snapshot for run ${runId} in ${dir}`)
}
