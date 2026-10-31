import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join as joinPath } from "node:path"
import { createServer } from "node:http"
import { SemanticEvent, createHuman } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { join, sendEvent } from "../shared/runtime.ts"
import { validate } from "../shared/validate.ts"
import { _resetForTests, handle } from "./server.ts"

process.env.DATA_DIR = mkdtempSync(joinPath(tmpdir(), "swarm-")) // keep test runs out of the real run list
const profile = JSON.parse(readFileSync("mocks/company_profile.sample.json", "utf8"))
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
let runId = ""

test("API: start run, checkpoint, topics, SSE replay with Last-Event-ID", async () => {
	const server = createServer(handle)
	await new Promise<void>((r) => server.listen(0, r))
	const base = `http://localhost:${(server.address() as { port: number }).port}`
	const api = (path: string, init?: RequestInit) => fetch(base + path, init)

	let r = await api("/runs", { method: "POST", body: JSON.stringify({ profile, planner: false, research: false, slots: { scout: 1 } }) })
	assert.equal(r.status, 201)
	const { run_id } = (await r.json()) as { run_id: string }
	runId = run_id
	assert.equal((await api("/runs", { method: "POST", body: "{}" })).status, 409)
	r = await api("/runs")
	assert.equal(r.status, 200)
	assert.ok(Array.isArray(await r.json()))
	assert.equal((await api(`/runs/${run_id}/plan`)).status, 404)
	const summary = (await (await api(`/runs/${run_id}`)).json()) as { status: string; profile: { name: string } }
	assert.equal(summary.status, "planning")
	assert.equal(summary.profile.name, (profile as { name: string }).name) // the dashboard header reads it

	// Stand in for the Planner: put topics on the board and announce them.
	const { resolveRuntime } = await import("../shared/runtime.ts")
	const state = resolveRuntime().state
	for (const id of ["t_001", "t_002"]) state.topics.set(id, { schema_version: "1.0", id, run_id: run_id, title: id, category: "market", state: "queued", importance_prior: 0.6 })
	const fake = createHuman({ name: "FakePlanner", capabilities: [], handlers: [] })
	join(fake)
	sendEvent(SemanticEvent.create(EV.TopicsProposed, fake.getId(), { topicIds: ["t_001", "t_002"], skipped: [] }), fake.getId())
	await tick()

	let run = (await (await api(`/runs/${run_id}`)).json()) as { status: string; checkpoints: { id: string; status: string }[] }
	assert.equal(run.status, "awaiting_checkpoint")
	assert.equal(run.checkpoints[0]?.id, "cp_topics")

	r = await api(`/runs/${run_id}/checkpoints/cp_topics`, { method: "POST", body: JSON.stringify({ approved: true }) })
	assert.equal(r.status, 200)
	assert.equal((await api(`/runs/${run_id}/checkpoints/cp_topics`, { method: "POST", body: "{}" })).status, 404) // already resolved
	await tick()
	run = (await (await api(`/runs/${run_id}`)).json()) as typeof run
	assert.equal(run.status, "researching")
	const topics = (await (await api(`/runs/${run_id}/topics`)).json()) as { id: string; state: string }[]
	assert.deepEqual(topics.map((t) => t.state), ["scouting", "queued"]) // one scout slot
	assert.equal(state.slots.get("a_sc1")?.topicId, "t_001")

	// Every AgentEvent is contract-valid and the sequence tells the story.
	for (const e of state.agentEvents) assert.equal(validate("agent_event", e), null)
	assert.deepEqual(
		state.agentEvents.map((e) => e.type),
		["run_started", "topics_proposed", "checkpoint_requested", "checkpoint_resolved", "topic_approved", "topic_state_changed", "agent_assigned"],
	)

	// Assumption editor: the override reaches analysis (C) and lands on the assumption.
	state.assumptions.set("as_001", { schema_version: "1.0", id: "as_001", run_id, text: "price", unit: "EUR", low: 1, base: 2, high: 3 })
	assert.equal((await api(`/runs/${run_id}/assumptions/as_999`, { method: "POST", body: "{}" })).status, 404)
	assert.equal((await api(`/runs/${run_id}/assumptions/as_001`, { method: "POST", body: JSON.stringify({ value: "x" }) })).status, 400)
	assert.equal((await api(`/runs/${run_id}/assumptions/as_001`, { method: "POST", body: JSON.stringify({ value: 5 }) })).status, 202)
	await tick()
	assert.equal(state.assumptions.get("as_001")?.user_override, 5)
	assert.equal(((await (await api(`/runs/${run_id}/assumptions`)).json()) as { id: string }[])[0]?.id, "as_001")

	// SSE replay from Last-Event-ID, then a live event.
	const ac = new AbortController()
	const sse = await api(`/runs/${run_id}/events`, { headers: { "last-event-id": "4" }, signal: ac.signal })
	assert.equal(sse.headers.get("content-type"), "text/event-stream")
	const reader = sse.body!.getReader()
	let text = ""
	const readUntil = async (needle: string) => {
		while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value)
	}
	await readUntil("id: 6\n")
	assert.ok(!text.includes("id: 4\n") && text.includes("id: 5\n"))
	sendEvent(SemanticEvent.create(EV.TopicScored, fake.getId(), { topicId: "t_001", relevance: 0.1, impact: 0.5, rationale: "x" }), fake.getId())
	await readUntil("event: agent_reassigned")
	assert.ok(text.includes("event: topic_dropped"))
	ac.abort()

	// Stop: the run ends, the response asks the supervisor to swap the worker, and a new run is then refused by this worker with the same marker.
	r = await api(`/runs/${run_id}/stop`, { method: "POST" })
	assert.equal(r.status, 202)
	assert.equal(r.headers.get("x-swarm-replace"), "1")
	assert.equal(((await r.json()) as { status: string }).status, "stopped")
	r = await api("/runs", { method: "POST", body: JSON.stringify({ profile }) })
	assert.equal(r.status, 409)
	assert.equal(r.headers.get("x-swarm-replace"), "1")
	server.close()
})

test("API: a run that is not live is served read-only from its snapshot", async () => {
	await tick(400) // debounced snapshot write
	_resetForTests()
	const server = createServer(handle)
	await new Promise<void>((r) => server.listen(0, r))
	const base = `http://localhost:${(server.address() as { port: number }).port}`
	const run = (await (await fetch(`${base}/runs/${runId}`)).json()) as { live: boolean; status: string; profile: { name: string } }
	assert.equal(run.live, false)
	assert.equal(run.status, "stopped")
	assert.equal(run.profile.name, (profile as { name: string }).name)
	assert.equal(((await (await fetch(`${base}/runs/${runId}/topics`)).json()) as unknown[]).length, 2)
	assert.equal((await fetch(`${base}/runs/${runId}/assumptions/as_001`, { method: "POST", body: "{}" })).status, 409)
	assert.equal((await fetch(`${base}/runs/r_nope`)).status, 404)
	server.close()
})
