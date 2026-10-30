// JSON snapshot of RunState (storage v1) for crash recovery and the dashboard's run history.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Obj, RunState, Slot } from "../shared/runtime.ts"

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

export function snapshotPath(runId: string, dir = "data"): string {
	return join(dir, `${runId}.json`)
}

export function writeSnapshot(s: RunState, dir = "data"): string {
	mkdirSync(dir, { recursive: true })
	const path = snapshotPath(s.runId, dir)
	writeFileSync(path, JSON.stringify(snapshot(s)))
	return path
}

export function readSnapshot(runId: string, dir = "data"): Snapshot {
	return JSON.parse(readFileSync(snapshotPath(runId, dir), "utf8")) as Snapshot
}
