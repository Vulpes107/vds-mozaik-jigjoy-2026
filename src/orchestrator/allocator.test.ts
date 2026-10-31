import { test } from "node:test"
import assert from "node:assert/strict"
import { EV } from "../shared/events.ts"
import type { Slot } from "../shared/runtime.ts"
import { allocate, researchBudget, researchLimit, defaultConfig, type Action, type Board, type Topic } from "./allocator.ts"

function board(topics: Partial<Topic>[], slots: Record<string, Slot["role"]>, runBudget = {}): Board {
	return {
		topics: new Map(topics.map((t, i) => [t.id ?? `t_${i}`, { id: `t_${i}`, state: "queued", importance_prior: 0.5, ...t } as Topic])),
		slots: new Map(Object.entries(slots).map(([id, role]) => [id, { role, topicId: null, assignedAt: 0, reassignments: 0 }])),
		runBudget,
		spent: { tokens: 0, calls: 0, usd: 0, seconds: 0 },
	}
}
const assigns = (a: Action[]) => a.filter((x) => x.type === EV.TaskAssigned) as Extract<Action, { type: typeof EV.TaskAssigned }>[]
const cfg = { ...defaultConfig, minDwellMs: 0 }

test("low-relevance topic is dropped within one scout cycle and its slot is reassigned", () => {
	const b = board([{ id: "t_1", importance_prior: 0.9 }, { id: "t_2", importance_prior: 0.5 }, { id: "t_3", importance_prior: 0.4 }], { s1: "scout" })
	let a = allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 1000)
	assert.deepEqual(assigns(a).map((x) => x.topicId), ["t_1"]) // highest prior first
	assert.equal(b.topics.get("t_1")!.state, "scouting")

	a = allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.1, impact: 0.9, rationale: "unrelated region" } }, cfg, 2000)
	const t1 = b.topics.get("t_1")!
	assert.equal(t1.state, "dropped")
	assert.match(t1.state_reason!, /unrelated region/)
	assert.ok(a.some((x) => x.type === EV.TopicDropped))
	const re = assigns(a)[0]!
	assert.equal(re.slotId, "s1")
	assert.equal(re.topicId, "t_2")
	assert.equal(re.fromTopicId, "t_1") // visible on the dashboard: dropped topic -> next topic
	assert.equal(b.slots.get("s1")!.topicId, "t_2")
	assert.equal(b.slots.get("s1")!.reassignments, 0) // but the scout finished its job; not counted against it
	assert.equal(b.topics.get("t_2")!.reassignment_count ?? 0, 0)
})

test("gate: shallow vs deep, and roles needed per state", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }], { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 1)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.5, impact: 0.2, rationale: "" } }, cfg, 2)
	assert.equal(b.topics.get("t_1")!.state, "shallow")
	assert.equal(b.slots.get("an1")!.topicId, "t_1")
	assert.equal(b.slots.get("c1")!.topicId, null) // shallow gets no collector
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_2", relevance: 0.8, impact: 0.7, rationale: "" } }, cfg, 3)
	assert.equal(b.topics.get("t_2")!.state, "deep")
	assert.equal(b.slots.get("c1")!.topicId, "t_2")
	assert.equal(b.slots.get("v1")!.topicId, null) // deep work is staged: the verifier waits for findings to check
	allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "an1", role: "analyst", outcome: "done", findings: 1, sources: 0 } }, cfg, 4)
	assert.equal(b.slots.get("an1")!.topicId, null) // free, but t_2's collector has not delivered yet
	allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_2", slotId: "c1", role: "collector", outcome: "done", findings: 0, sources: 3 } }, cfg, 5)
	assert.equal(b.slots.get("an1")!.topicId, "t_2") // the analyst gets the collector's material
	assert.equal(b.slots.get("v1")!.topicId, null)
	allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_2", slotId: "an1", role: "analyst", outcome: "done", findings: 2, sources: 0 } }, cfg, 6)
	assert.equal(b.slots.get("v1")!.topicId, "t_2")
})

test("no oscillation: scores bouncing around the drop threshold over 100 ticks change state once", () => {
	const b = board([{ id: "t_1" }], { s1: "scout" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	let changes = 0
	for (let i = 1; i <= 100; i++) {
		const relevance = i % 2 ? 0.29 : 0.34 // below drop, then inside the hysteresis band
		const a = allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance, impact: 0.5, rationale: "" } }, cfg, i)
		changes += a.filter((x) => x.type === EV.TopicStateChanged).length
	}
	assert.equal(changes, 1)
	assert.equal(b.topics.get("t_1")!.state, "dropped")
	// Clear new evidence above the band reopens it.
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.6, impact: 0.5, rationale: "" } }, cfg, 101)
	assert.notEqual(b.topics.get("t_1")!.state, "dropped")
})

test("budget exhaustion stops research and lists unresolved topics", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }], { s1: "scout" }, { calls: 10 })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	let a = allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId: "s1", spent: { calls: 8 } } }, cfg, 1)
	assert.ok(a.some((x) => x.type === EV.BudgetWarning))
	a = allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId: "s1", spent: { calls: 2 } } }, cfg, 2)
	assert.ok(a.some((x) => x.type === EV.BudgetExhausted))
	const req = a.find((x) => x.type === EV.AnalysisRequested) as Extract<Action, { type: typeof EV.AnalysisRequested }>
	assert.deepEqual(req.unresolvedTopicIds, ["t_1", "t_2"])
	// Idempotent: a later event neither re-warns nor re-requests analysis.
	a = allocate(b, { type: EV.SlotIdle, payload: { slotId: "s1" } }, cfg, 3)
	assert.equal(a.length, 0)
})

test("full run: every topic reaches closed or dropped, then analysis is requested", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }, { id: "t_3" }], { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	const all: Action[] = []
	let now = 1
	// Drive until quiet: scouts score, workers finish, confidence climbs.
	for (let i = 0; i < 50 && !all.some((x) => x.type === EV.AnalysisRequested); i++) {
		for (const [slotId, s] of b.slots) {
			if (!s.topicId) continue
			const t = b.topics.get(s.topicId)!
			if (s.role === "scout") {
				const rel = t.id === "t_3" ? 0.1 : 0.9
				const imp = t.id === "t_2" ? 0.2 : 0.8
				all.push(...allocate(b, { type: EV.TopicScored, payload: { topicId: t.id, relevance: rel, impact: imp, rationale: "seed" } }, cfg, now++))
			} else {
				all.push(...allocate(b, { type: EV.TopicProgress, payload: { topicId: t.id, slotId, confidence: 0.5 } }, cfg, now++))
				all.push(...allocate(b, { type: EV.TaskFinished, payload: { topicId: t.id, slotId, role: s.role } }, cfg, now++))
			}
		}
	}
	assert.deepEqual([...b.topics.values()].map((t) => [t.id, t.state]), [["t_1", "closed"], ["t_2", "closed"], ["t_3", "dropped"]])
	const req = all.find((x) => x.type === EV.AnalysisRequested) as Extract<Action, { type: typeof EV.AnalysisRequested }>
	assert.deepEqual(req.unresolvedTopicIds, [])
	assert.deepEqual(req.droppedTopicIds, ["t_3"])
	assert.ok([...b.slots.values()].every((s) => s.topicId === null))
})

test("a deep topic that ends its first pass thin gets one more collector->analyst->verifier pass, then closes", () => {
	const b = board([{ id: "t_1" }], { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" }, { usd: 10, seconds: 3600 })
	b.findings = new Map([["f_1", { topic_id: "t_1" }]])
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 1)
	let now = 2
	const pass = (confidence: number) => {
		const out: Action[] = []
		for (const [slotId, role] of [["c1", "collector"], ["an1", "analyst"], ["v1", "verifier"]] as const) {
			allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId, confidence } }, cfg, now++)
			out.push(...allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId, role, findings: 1, sources: 1 } }, cfg, now++))
		}
		return out
	}
	const after1 = pass(0.4)
	assert.equal(b.topics.get("t_1")!.state, "deep")
	assert.match(b.topics.get("t_1")!.state_reason ?? "", /^second pass: confidence 0.4/)
	const again = assigns(after1).find((a) => a.role === "collector")
	assert.ok(again && again.handoff?.startsWith("second pass"), "the collector is re-assigned with the handoff note")
	pass(0.5)
	assert.equal(b.topics.get("t_1")!.state, "closed") // only one extra pass
	// Without a topic's worth of research budget left there is no second pass.
	const poor = board([{ id: "t_1" }], { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" }, { usd: 1, seconds: 3600 })
	poor.findings = new Map([["f_1", { topic_id: "t_1" }]])
	poor.spent.usd = 0.3 // research share is 0.5: 0.2 left, below one topic's worth (0.35)
	allocate(poor, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(poor, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 1)
	for (const [slotId, role] of [["c1", "collector"], ["an1", "analyst"], ["v1", "verifier"]] as const) {
		allocate(poor, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId, confidence: 0.4 } }, cfg, now++)
		allocate(poor, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId, role, findings: 1, sources: 1 } }, cfg, now++)
	}
	assert.equal(poor.topics.get("t_1")!.state, "closed")
})

test("close early on high confidence, but a deep topic waits for its verifier", () => {
	const b = board([{ id: "t_1" }], { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 1)
	allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId: "an1", confidence: 0.95 } }, cfg, 2)
	assert.equal(b.topics.get("t_1")!.state, "deep")
	allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "v1", role: "verifier" } }, cfg, 3)
	allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId: "an1", confidence: 0.95 } }, cfg, 4)
	assert.equal(b.topics.get("t_1")!.state, "closed")
})

test("a research gap is a reason, not a verdict: the topic ends only when the task finishes with nothing and nobody else is on it", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }], { s1: "scout", c1: "collector" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 1)
	allocate(b, { type: EV.ResearchGap, payload: { topicId: "t_1", slotId: "c1", reason: "provider outage" } }, cfg, 2)
	assert.equal(b.topics.get("t_1")!.state, "deep") // the collector is still working; one failed call need not end the topic
	assert.equal(b.slots.get("c1")!.topicId, "t_1")
	const a = allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "c1", role: "collector", outcome: "done", findings: 0, sources: 0 } }, cfg, 3)
	assert.equal(b.topics.get("t_1")!.state, "research_incomplete")
	assert.equal(b.topics.get("t_1")!.state_reason, "provider outage")
	assert.equal(b.slots.get("c1")!.topicId, null)
	assert.equal(assigns(a).length, 0) // t_2 is still queued; the collector has nothing to do yet
})

test("anti-thrash: reassignment request honours dwell time; only mid-work moves count toward the max", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }], { s1: "scout", c1: "collector" })
	const dwell = { ...defaultConfig, minDwellMs: 1000, maxReassignments: 1 }
	allocate(b, { type: EV.TopicApproved, payload: {} }, dwell, 0)
	allocate(b, { type: EV.ReassignmentRequested, payload: { slotId: "s1", topicId: "t_1", reason: "stuck" } }, dwell, 500)
	assert.equal(b.slots.get("s1")!.topicId, "t_1") // too early
	allocate(b, { type: EV.ReassignmentRequested, payload: { slotId: "s1", topicId: "t_1", reason: "stuck" } }, dwell, 1500)
	assert.equal(b.slots.get("s1")!.topicId, "t_1") // freed and immediately re-picked: same topic, not counted
	assert.equal(b.slots.get("s1")!.reassignments, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, dwell, 1600)
	assert.equal(b.slots.get("s1")!.topicId, "t_2") // scout moves on after scoring: normal work
	assert.equal(b.slots.get("c1")!.topicId, "t_1")
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_2", relevance: 0.9, impact: 0.9, rationale: "" } }, dwell, 1700)
	assert.equal(b.slots.get("s1")!.reassignments, 0)
	// t_1 is dropped on new evidence while the collector works on it: that is a real reassignment.
	const a = allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.1, impact: 0.9, rationale: "" } }, dwell, 1800)
	assert.deepEqual(assigns(a).map((x) => [x.slotId, x.topicId, x.fromTopicId]), [["c1", "t_2", "t_1"]])
	assert.equal(b.slots.get("c1")!.reassignments, 1)
	assert.equal(b.topics.get("t_2")!.reassignment_count, 1)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_2", relevance: 0.1, impact: 0.1, rationale: "" } }, dwell, 1900)
	assert.equal(b.slots.get("c1")!.topicId, null) // t_2 dropped; collector at max reassignments stays retired
})

test("a late task.finished for a topic the slot already left does not free the new assignment", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }, { id: "t_3" }], { s1: "scout" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 1)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 2)
	assert.equal(b.slots.get("s1")!.topicId, "t_2") // moved on as soon as t_1 was scored
	const a = allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "s1", role: "scout" } }, cfg, 3)
	assert.equal(b.slots.get("s1")!.topicId, "t_2") // still on t_2, not re-handed to t_3
	assert.equal(assigns(a).length, 0)
	assert.equal(b.topics.get("t_1")!.state, "deep")
})

test("a scout that finishes without scoring gets the topic retried, then research_incomplete", () => {
	const b = board([{ id: "t_1" }], { s1: "scout" })
	const c = { ...cfg, maxReassignments: 2 }
	allocate(b, { type: EV.TopicApproved, payload: {} }, c, 0)
	for (let i = 1; i <= 2; i++) {
		allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "s1", role: "scout" } }, c, i)
		assert.equal(b.topics.get("t_1")!.state, "scouting") // requeued and immediately re-picked
		assert.equal(b.topics.get("t_1")!.reassignment_count, i)
	}
	const a = allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "s1", role: "scout" } }, c, 3)
	assert.equal(b.topics.get("t_1")!.state, "research_incomplete")
	assert.match(b.topics.get("t_1")!.state_reason!, /without scoring; retries exhausted/)
	const req = a.find((x) => x.type === EV.AnalysisRequested) as Extract<Action, { type: typeof EV.AnalysisRequested }>
	assert.deepEqual(req.unresolvedTopicIds, ["t_1"])
})

test("tick: stuck slots time out, wall-clock counts against the budget, unservable topics end the run", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }], { s1: "scout", c1: "collector" }, { seconds: 100 })
	b.startedAt = 0
	const c = { ...cfg, taskTimeoutMs: 1000 }
	allocate(b, { type: EV.TopicApproved, payload: {} }, c, 0)
	assert.equal(b.slots.get("s1")!.topicId, "t_1")
	allocate(b, { type: EV.AllocatorTick, payload: {} }, c, 500)
	assert.equal(b.slots.get("s1")!.topicId, "t_1") // not yet
	let a = allocate(b, { type: EV.AllocatorTick, payload: {} }, c, 1500)
	assert.equal(b.topics.get("t_1")!.reassignment_count, 1)
	assert.ok(a.some((x) => x.type === EV.TopicStateChanged && /timed out/.test(x.reason)))
	assert.equal(b.slots.get("s1")!.topicId, "t_1") // retried: back on the board, re-picked (still the best scout target)
	assert.equal(b.spent.seconds, 1)

	// t_2 scored deep needs a verifier, but there is no verifier slot: the next tick ends the wait.
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.1, impact: 0.1, rationale: "" } }, c, 1600)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_2", relevance: 0.9, impact: 0.9, rationale: "" } }, c, 1700)
	assert.equal(b.topics.get("t_2")!.state, "deep")
	a = allocate(b, { type: EV.AllocatorTick, payload: {} }, c, 1800)
	assert.equal(b.topics.get("t_2")!.state, "research_incomplete")
	assert.match(b.topics.get("t_2")!.state_reason!, /no analyst\/verifier slot/)
	assert.ok(a.some((x) => x.type === EV.AnalysisRequested))

	// Wall clock alone exhausts the run.
	const b2 = board([{ id: "t_1" }], { s1: "scout" }, { seconds: 100 })
	b2.startedAt = 0
	a = allocate(b2, { type: EV.AllocatorTick, payload: {} }, c, 100_000)
	assert.ok(a.some((x) => x.type === EV.BudgetExhausted))
})

test("research stops at its share of the budget; the rest is reserved for analysis", () => {
	assert.equal(researchLimit("usd", 3), 2.25) // max(0.75, 0.75)
	assert.equal(researchLimit("usd", 1), 0.5) // never more than half
	assert.equal(researchLimit("usd", 10), 7.5) // fraction wins on big budgets
	assert.equal(researchLimit("seconds", 900), 660)
	assert.equal(researchLimit("calls", 10), 10) // search calls are research-only
	assert.deepEqual(researchBudget({ usd: 3, seconds: 900 }), { usd: 2.25, seconds: 660 })
	const b = board([{ id: "t_1" }], { s1: "scout" }, { usd: 3 })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	const a = allocate(b, { type: EV.SpendRecorded, payload: { agentId: "x", model: "m", tokens: 1, usd: 2.3 } }, cfg, 1)
	const ex = a.find((x) => x.type === EV.BudgetExhausted) as Extract<Action, { type: typeof EV.BudgetExhausted }>
	assert.deepEqual({ limit: ex.limit, reserved: ex.reserved }, { limit: 2.25, reserved: 0.75 })
	assert.ok(a.some((x) => x.type === EV.AnalysisRequested))
})

test("the clock stops once the plan is ready", () => {
	const b = board([{ id: "t_1" }], { s1: "scout" }, { seconds: 900 })
	b.startedAt = 0
	allocate(b, { type: EV.AllocatorTick, payload: {} }, cfg, 10_000)
	assert.equal(b.spent.seconds, 10)
	allocate(b, { type: EV.PlanReady, payload: {} }, cfg, 20_000)
	allocate(b, { type: EV.AllocatorTick, payload: {} }, cfg, 60_000)
	assert.equal(b.spent.seconds, 10)
})

test("a task that hit its own budget counts as finished (its findings stand); a timeout is retried", () => {
	const b = board([{ id: "t_1" }], { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 1)
	const a = allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "c1", role: "collector", outcome: "budget_exhausted", findings: 2, sources: 3 } }, cfg, 2)
	assert.equal(b.topics.get("t_1")!.reassignment_count ?? 0, 0)
	assert.equal(b.slots.get("c1")!.topicId, null) // collector done for this topic; nothing else to collect
	assert.ok(!assigns(a).some((x) => x.slotId === "c1"))
})

test("a task that ends with a non-done outcome is retried instead of counted as finished", () => {
	const b = board([{ id: "t_1" }], { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 1)
	assert.equal(b.slots.get("c1")!.topicId, "t_1")
	const a = allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "c1", role: "collector", outcome: "timeout", findings: 0, sources: 0 } }, cfg, 2)
	assert.equal(b.topics.get("t_1")!.state, "deep")
	assert.equal(b.topics.get("t_1")!.reassignment_count, 1)
	assert.equal(assigns(a)[0]?.slotId, "c1") // the collector role is handed out again
	assert.equal(b.slots.get("c1")!.topicId, "t_1")
})

test("a research gap keeps a topic that already has findings, and ends one that has none", () => {
	const b = board([{ id: "t_1" }, { id: "t_2" }], { s1: "scout", c1: "collector" })
	b.findings = new Map([["f_1", { topic_id: "t_1" }]])
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 1)
	allocate(b, { type: EV.ResearchGap, payload: { topicId: "t_1", slotId: "c1", reason: "paywalled report" } }, cfg, 2)
	assert.equal(b.topics.get("t_1")!.state, "deep")
	assert.equal(b.topics.get("t_1")!.state_reason, "gap: paywalled report")
	assert.equal(b.slots.get("c1")!.topicId, "t_1")
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_2", relevance: 0.9, impact: 0.9, rationale: "" } }, cfg, 3)
	allocate(b, { type: EV.ResearchGap, payload: { topicId: "t_2", slotId: "c1", reason: "provider outage" } }, cfg, 4)
	allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_2", slotId: "c1", role: "collector", outcome: "done", findings: 0, sources: 0 } }, cfg, 5)
	assert.equal(b.topics.get("t_2")!.state, "research_incomplete")
	allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "c1", role: "collector", outcome: "done", findings: 0, sources: 0 } }, cfg, 6)
	assert.equal(b.topics.get("t_1")!.state, "deep") // it has findings: the analyst still gets its turn
})

test("a scout working through many topics is never retired", () => {
	const b = board(Array.from({ length: 12 }, (_, i) => ({ id: `t_${i}` })), { s1: "scout" })
	const c = { ...cfg, maxReassignments: 3 }
	allocate(b, { type: EV.TopicApproved, payload: {} }, c, 0)
	for (let i = 1; i <= 12; i++) {
		const id = b.slots.get("s1")!.topicId!
		allocate(b, { type: EV.TopicScored, payload: { topicId: id, relevance: 0.9, impact: 0.2, rationale: "" } }, c, i)
		allocate(b, { type: EV.TaskFinished, payload: { topicId: id, slotId: "s1", role: "scout", outcome: "done" } }, c, i)
	}
	assert.equal(b.slots.get("s1")!.reassignments, 0)
	assert.equal([...b.topics.values()].filter((t) => t.state === "shallow").length, 12)
})

test("nothing is assigned before the human approves the topic list (a tick or spend event must not start research)", () => {
	const b = board([{ id: "t_1", importance_prior: 0.9 }], { s1: "scout" })
	assert.equal(assigns(allocate(b, { type: EV.AllocatorTick, payload: {} }, cfg, 1000)).length, 0)
	assert.equal(assigns(allocate(b, { type: EV.SpendRecorded, payload: { tokens: 10, usd: 0.001 } }, cfg, 1000)).length, 0)
	assert.equal(b.topics.get("t_1")!.state, "queued")
	assert.equal(assigns(allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 2000)).length, 1)
})

test("replan: research budget left after every topic closes buys a follow-up round before analysis; new topics need no re-approval", () => {
	const b = board([{ id: "t_1" }], { s1: "scout", an1: "analyst" }, { usd: 5 })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.9, impact: 0.2, rationale: "seed" } }, cfg, 1) // shallow: analyst only
	let a = allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: "an1", role: "analyst" } }, cfg, 2)
	assert.deepEqual(a.find((x) => x.type === EV.ReplanRequested), { type: EV.ReplanRequested, remaining: { usd: 3.75 }, round: 1 }) // 5 minus the 1.25 analysis reserve
	assert.ok(!a.some((x) => x.type === EV.AnalysisRequested))
	// Waiting for the Planner: a tick neither asks again nor starts analysis.
	assert.equal(allocate(b, { type: EV.AllocatorTick, payload: {} }, cfg, 3).length, 0)
	b.topics.set("t_2", { id: "t_2", state: "queued", importance_prior: 0.5 } as Topic)
	a = allocate(b, { type: EV.TopicsProposed, payload: { topicIds: ["t_2"], skipped: [], round: 1 } }, cfg, 4)
	assert.deepEqual(assigns(a).map((x) => [x.slotId, x.topicId]), [["s1", "t_2"]])
	// The round spends the money down: the next quiet board goes to analysis.
	allocate(b, { type: EV.TopicScored, payload: { topicId: "t_2", relevance: 0.9, impact: 0.2, rationale: "seed" } }, cfg, 5)
	allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_2", slotId: "an1", spent: { usd: 3.5 } } }, cfg, 6)
	a = allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_2", slotId: "an1", role: "analyst" } }, cfg, 7)
	assert.ok(a.some((x) => x.type === EV.AnalysisRequested))
	assert.ok(!a.some((x) => x.type === EV.ReplanRequested))
})

test("replan: an empty round, a Planner that never answers, or rounds used up each end in analysis", () => {
	let b = board([{ id: "t_1", state: "closed" }], { s1: "scout" }, { usd: 5 })
	let a = allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	assert.ok(a.some((x) => x.type === EV.ReplanRequested))
	a = allocate(b, { type: EV.TopicsProposed, payload: { topicIds: [], skipped: [], round: 1 } }, cfg, 1)
	assert.ok(a.some((x) => x.type === EV.AnalysisRequested))

	b = board([{ id: "t_1", state: "closed" }], { s1: "scout" }, { usd: 5 })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 0)
	assert.equal(allocate(b, { type: EV.AllocatorTick, payload: {} }, cfg, cfg.taskTimeoutMs - 1).length, 0)
	assert.ok(allocate(b, { type: EV.AllocatorTick, payload: {} }, cfg, cfg.taskTimeoutMs).some((x) => x.type === EV.AnalysisRequested))

	b = board([{ id: "t_1", state: "closed" }], { s1: "scout" }, { usd: 5 })
	a = allocate(b, { type: EV.TopicApproved, payload: {} }, { ...cfg, maxReplanRounds: 0 }, 0)
	assert.ok(a.some((x) => x.type === EV.AnalysisRequested))
	assert.ok(!a.some((x) => x.type === EV.ReplanRequested))
})

test("budget exhaustion marks every live topic research_incomplete so the plan, the table and the counts agree", () => {
	const b = board([{ id: "t_1", importance_prior: 0.9 }, { id: "t_2", importance_prior: 0.5 }], { s1: "scout" }, { calls: 10 })
	allocate(b, { type: EV.TopicApproved, payload: {} }, cfg, 1)
	const a = allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId: "s1", spent: { calls: 10 } } }, cfg, 2)
	const req = a.find((x) => x.type === EV.AnalysisRequested) as Extract<Action, { type: typeof EV.AnalysisRequested }>
	assert.deepEqual(req.unresolvedTopicIds, ["t_1", "t_2"])
	assert.equal(b.topics.get("t_1")!.state, "research_incomplete")
	assert.match(b.topics.get("t_1")!.state_reason!, /before this topic finished/)
	assert.match(b.topics.get("t_2")!.state_reason!, /before this topic was staffed/)
	assert.equal(a.filter((x) => x.type === EV.TopicStateChanged).length, 2)
})

test("a thin deep topic gets its second pass only when the budget also covers every topic still waiting, and waiting topics are staffed first", () => {
	// Research share of 1 USD is 0.5 USD (the analysis reserve takes the rest): exactly one topic's worth at 0.3 USD... not two.
	const c = { ...cfg, topicCost: { usd: 0.3, seconds: 0 } }
	const run = (withOther: boolean) => {
		const topics = [{ id: "t_1", importance_prior: 0.5 }, ...(withOther ? [{ id: "t_2", importance_prior: 0.9 }] : [])]
		const b = board(topics, { s1: "scout", c1: "collector", an1: "analyst", v1: "verifier" }, { usd: 1 })
		b.findings = new Map([["f_1", { topic_id: "t_1" }]])
		allocate(b, { type: EV.TopicApproved, payload: {} }, c, 1)
		allocate(b, { type: EV.TopicScored, payload: { topicId: "t_1", relevance: 0.8, impact: 0.7, rationale: "" } }, c, 2)
		if (withOther) allocate(b, { type: EV.TopicScored, payload: { topicId: "t_2", relevance: 0.8, impact: 0.9, rationale: "" } }, c, 3)
		// t_1's first pass: collector -> analyst -> verifier, confidence stays thin.
		for (const [slot, role] of [["c1", "collector"], ["an1", "analyst"], ["v1", "verifier"]] as const) {
			b.slots.get(slot)!.topicId = "t_1"
			allocate(b, { type: EV.TopicProgress, payload: { topicId: "t_1", slotId: slot, confidence: 0.4 } }, c, 4)
			allocate(b, { type: EV.TaskFinished, payload: { topicId: "t_1", slotId: slot, role, outcome: "done", findings: 1, sources: 1 } }, c, 5)
		}
		return b
	}
	assert.match(run(false).topics.get("t_1")!.state_reason!, /second pass/)
	const b = run(true)
	assert.equal(b.topics.get("t_1")!.state, "closed") // t_2 still waits for its first pass and the budget covers one topic, not two
	assert.equal(b.slots.get("c1")!.topicId, "t_2")
})
