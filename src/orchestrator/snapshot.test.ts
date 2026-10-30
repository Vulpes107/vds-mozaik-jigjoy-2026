import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunState } from "../shared/runtime.ts"
import { readSnapshot, restore, snapshot, writeSnapshot } from "./snapshot.ts"
import { openStore } from "./store.ts"

test("snapshot round-trips RunState; slots come back idle for the Allocator to refill", () => {
	const dir = mkdtempSync(join(tmpdir(), "snap-"))
	const a = new RunState()
	a.runId = "r_snap"
	a.profile = { id: "p_x", schema_version: "1.0", name: "X", description: "d", products: [] }
	a.topics.set("t_1", { id: "t_1", state: "deep", importance_prior: 0.5, assigned_agents: ["a_sc1"] })
	a.findings.set("f_1", { id: "f_1", topic_id: "t_1" })
	a.checkpoints.set("cp_topics", { id: "cp_topics", status: "approved" })
	a.slots.set("a_sc1", { role: "scout", topicId: "t_1", assignedAt: 5, reassignments: 2 })
	a.agentEvents.push({ id: "e", seq: 0, type: "run_started" })
	a.runBudget = { usd: 5 }
	a.spent = { tokens: 100, calls: 2, usd: 0.5, seconds: 0 }

	const path = writeSnapshot(a, dir)
	const b = restore(new RunState(), readSnapshot("r_snap", dir))

	assert.ok(path.endsWith("mozaik.db"))
	assert.equal(b.runId, "r_snap")
	assert.deepEqual(b.profile, a.profile)
	assert.deepEqual(b.topics.get("t_1"), { ...a.topics.get("t_1"), assigned_agents: [] })
	assert.deepEqual(b.findings.get("f_1"), a.findings.get("f_1"))
	assert.equal(b.checkpoints.get("cp_topics")?.status, "approved")
	assert.deepEqual(b.slots.get("a_sc1"), { role: "scout", topicId: null, assignedAt: 5, reassignments: 2 })
	assert.deepEqual(b.agentEvents, a.agentEvents)
	assert.deepEqual(b.spent, a.spent)
	assert.deepEqual(b.runBudget, a.runBudget)
	// Second snapshot of the restored state is identical apart from the timestamp.
	const { savedAt: _1, ...s1 } = snapshot(a)
	const { savedAt: _2, ...s2 } = snapshot(b)
	assert.deepEqual(s2, { ...s1, topics: s2.topics, slots: s2.slots })
})

test("writeSnapshot upserts one row per run; list is newest-first and filters by project", () => {
	const dir = mkdtempSync(join(tmpdir(), "snap-"))
	const mk = (runId: string, projectId: string) => {
		const s = new RunState()
		s.runId = runId
		s.profile = { id: "p_x", project_id: projectId, name: `Co ${runId}` }
		return s
	}
	const a = mk("r_a", "p_one")
	writeSnapshot(a, dir)
	a.spent.usd = 0.7
	a.topics.set("t_1", { id: "t_1" })
	writeSnapshot(a, dir)
	writeSnapshot(mk("r_b", "p_two"), dir)

	const store = openStore(dir)
	const all = store.list()
	assert.equal(all.length, 2)
	assert.deepEqual(store.list("p_one").map((r) => [r.run_id, r.company, r.status, r.spent_usd]), [["r_a", "Co r_a", "researching", 0.7]])
	assert.equal(readSnapshot("r_a", dir).topics.length, 1)
	assert.throws(() => readSnapshot("r_missing", dir), /no snapshot/)
	store.close()
})

test("readSnapshot falls back to a legacy <runId>.json file", () => {
	const dir = mkdtempSync(join(tmpdir(), "snap-"))
	const s = new RunState()
	s.runId = "r_old"
	writeFileSync(join(dir, "r_old.json"), JSON.stringify(snapshot(s)))
	assert.equal(readSnapshot("r_old", dir).runId, "r_old")
})
