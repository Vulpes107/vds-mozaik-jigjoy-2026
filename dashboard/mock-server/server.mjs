#!/usr/bin/env node
// Mock REST + SSE API for the dashboard, mirroring src/orchestrator/server.ts's shape
// (ADR 0001) so the frontend can be built against it before A's real server exists.
// Serves fixtures from /mocks and replays mocks/agent_event*.json on the SSE stream
// with realistic timing, applying each event's effect to in-memory topics/findings.
//
// Usage: node dashboard/mock-server/server.mjs   (PORT, default 8787)
import { createServer } from "node:http"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const mockDir = join(root, "mocks")
const RUN_ID = "r_demo1"
const SPEED = Number(process.env.MOCK_SPEED ?? 20) // real run compresses minutes into seconds

function load(name) {
	try {
		return JSON.parse(readFileSync(join(mockDir, `${name}.json`), "utf8"))
	} catch {
		return undefined
	}
}
function asArray(x) {
	return Array.isArray(x) ? x : x ? [x] : []
}

const profile = load("company_profile.sample") ?? {}
const topics = new Map(asArray(load("topic.sample")).map((t) => [t.id, t]))
const findings = new Map(asArray(load("finding.sample")).map((f) => [f.id, f]))
const sources = new Map(asArray(load("source.sample")).map((s) => [s.id, s]))
const assumptions = new Map(asArray(load("assumption.sample")).map((a) => [a.id, a]))
const scenarios = new Map(asArray(load("scenario.sample")).map((s) => [s.id, s]))
const plan = load("business_plan.sample")
const checkpoints = new Map([["cp_topics", { id: "cp_topics", kind: "topics", status: "pending" }]])

const script = asArray(load("agent_event.sample")).sort((a, b) => a.seq - b.seq)
const agentEvents = [] // delivered-so-far, in order, for reconnect/backfill
const sseClients = new Set()

function send(client, e) {
	client.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
}
function broadcast(e) {
	agentEvents.push(e)
	for (const c of sseClients) send(c, e)
}
function applyEffect(e) {
	if (e.type === "topic_dropped" && topics.has(e.topic_id)) {
		const t = topics.get(e.topic_id)
		t.state = "dropped"
		t.assigned_agents = (t.assigned_agents ?? []).filter((a) => a !== e.agent_id)
	}
	if (e.type === "agent_reassigned" && topics.has(e.topic_id)) {
		const t = topics.get(e.topic_id)
		t.assigned_agents = [...new Set([...(t.assigned_agents ?? []), e.agent_id])]
		t.reassignment_count = (t.reassignment_count ?? 0) + 1
	}
	if (e.type === "finding_submitted" && e.finding_id && findings.has(e.finding_id)) {
		// no-op placeholder: findings already seeded, kept for shape parity
	}
}

function runStartedAtMs() {
	return script.length ? Date.parse(script[0].ts) : Date.now()
}
const demoStartMs = Date.now()
const scriptStartMs = runStartedAtMs()

function scheduleReplay() {
	for (const e of script) {
		const offsetMs = (Date.parse(e.ts) - scriptStartMs) / SPEED
		setTimeout(() => {
			applyEffect(e)
			broadcast(e)
		}, Math.max(0, offsetMs))
	}
}
scheduleReplay()

function runStatus() {
	if (plan) return "done"
	if ([...checkpoints.values()].some((c) => c.status === "pending")) return "awaiting_checkpoint"
	return "researching"
}

function json(res, status, body) {
	res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
	res.end(JSON.stringify(body))
}
async function readBody(req) {
	let s = ""
	for await (const c of req) s += c
	return s ? JSON.parse(s) : {}
}

function handle(req, res) {
	void (async () => {
		const url = new URL(req.url ?? "/", "http://x")
		const parts = url.pathname.split("/").filter(Boolean)
		if (req.method === "OPTIONS") return json(res, 204, {})

		if (req.method === "POST" && parts.length === 1 && parts[0] === "runs") {
			await readBody(req) // drain; mock server always serves the one fixed demo run
			return json(res, 201, { run_id: RUN_ID })
		}
		if (req.method === "GET" && parts.length === 1 && parts[0] === "runs") {
			return json(res, 200, [{ run_id: RUN_ID, project_id: profile.project_id ?? null, company: profile.name ?? null, status: runStatus(), saved_at: new Date().toISOString(), spent_usd: 0.4 }])
		}
		if (parts[0] !== "runs" || parts[1] !== RUN_ID) return json(res, 404, { error: "not found" })
		const rest = parts.slice(2)

		if (req.method === "GET" && rest.length === 0) {
			return json(res, 200, {
				run_id: RUN_ID,
				live: true,
				project_id: profile.project_id,
				status: runStatus(),
				profile,
				budget: { usd: 2, seconds: 1800 },
				spent: { usd: 0.4, seconds: 300 },
				topics: topics.size,
				checkpoints: [...checkpoints.values()],
			})
		}
		if (req.method === "GET" && rest[0] === "topics") return json(res, 200, [...topics.values()])
		if (req.method === "GET" && rest[0] === "findings") return json(res, 200, [...findings.values()])
		if (req.method === "GET" && rest[0] === "sources") return json(res, 200, [...sources.values()])
		if (req.method === "GET" && rest[0] === "assumptions") return json(res, 200, [...assumptions.values()])
		if (req.method === "POST" && rest[0] === "stop") return json(res, 202, { run_id: RUN_ID, status: "stopped" })
		if (req.method === "POST" && rest[0] === "assumptions" && rest[1]) {
			const a = assumptions.get(rest[1])
			if (!a) return json(res, 404, { error: "unknown assumption" })
			const b = await readBody(req)
			if (b.value !== null && typeof b.value !== "number") return json(res, 400, { error: "body must be { value: number | null }" })
			a.user_override = b.value ?? null
			return json(res, 202, { assumption_id: rest[1], value: a.user_override })
		}
		if (req.method === "GET" && rest[0] === "scenarios") return json(res, 200, [...scenarios.values()])
		if (req.method === "GET" && rest[0] === "plan") return plan ? json(res, 200, plan) : json(res, 404, { error: "plan not ready" })
		if (req.method === "POST" && rest[0] === "checkpoints" && rest[1]) {
			const cp = checkpoints.get(rest[1])
			if (!cp) return json(res, 404, { error: "no pending checkpoint with that id" })
			const b = await readBody(req)
			cp.status = b.approved === false ? "rejected" : "approved"
			return json(res, 200, cp)
		}
		if (req.method === "GET" && rest[0] === "events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"access-control-allow-origin": "*",
			})
			const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? -1)
			for (const e of agentEvents) if (e.seq > since) send(res, e)
			sseClients.add(res)
			const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000)
			req.on("close", () => {
				sseClients.delete(res)
				clearInterval(beat)
			})
			return
		}
		return json(res, 404, { error: "not found" })
	})().catch((e) => json(res, 500, { error: String(e) }))
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const port = Number(process.env.PORT ?? 8787)
	createServer(handle).listen(port, "127.0.0.1", () => {
		console.log(`mock dashboard API on http://localhost:${port} (run ${RUN_ID}, replay speed x${SPEED})`)
	})
}

export { handle }
