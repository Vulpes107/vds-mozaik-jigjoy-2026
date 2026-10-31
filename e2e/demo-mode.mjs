#!/usr/bin/env node
// Smoke test for the scripted 90-second demo (MOCK_DEMO=1): Start -> Approve -> drop + reassign -> plan -> price edit flips the verdict.
// Spawns the mock server itself on a free port at 30x speed; exits non-zero on breakage.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const port = 8800 + Math.floor(Math.random() * 90)
const server = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "mock-server", "server.mjs")], {
	env: { ...process.env, PORT: String(port), MOCK_DEMO: "1", DEMO_SPEED: "30" },
	stdio: "ignore",
})
const base = `http://127.0.0.1:${port}/runs/r_demo1`
const get = async (p) => (await fetch(base + p)).json()
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (m) => { console.error("FAIL:", m); server.kill(); process.exit(1) }
const ok = (c, m) => (c ? console.log("ok  ", m) : fail(m))

for (let i = 0; i < 50; i++) { try { await get(""); break } catch { await wait(100) } }
await fetch(`http://127.0.0.1:${port}/runs`, { method: "POST", body: "{}" })
ok((await get("")).status === "awaiting_checkpoint", "starts at the approval checkpoint")
ok((await get("/plan")).error === "plan not ready", "no plan before approval")
await post("/checkpoints/cp_topics", { approved: true })
let plan
for (let i = 0; i < 60 && !plan?.decisions; i++) { await wait(100); plan = await get("/plan") }
ok(plan?.decisions?.continue_vs_change.verdict === "expand", "plan arrives with verdict expand")
const topics = await get("/topics")
ok(topics.find((t) => t.id === "t_002").state === "dropped", "t_002 was dropped")
ok(topics.find((t) => t.id === "t_004").state === "research_incomplete", "t_004 ended incomplete")
ok(plan.unresolved_topic_ids.join() === "t_004" && plan.dropped_topic_ids.join() === "t_002", "plan lists unresolved and dropped topics")
const sc = await get("/scenarios")
ok(sc.find((s) => s.id === "sc_2").metrics.runway_breached === true, "Expand breaches runway at the base price")
await post("/assumptions/as_001", { value: 40 })
plan = await get("/plan")
ok(plan.decisions.continue_vs_change.verdict === "continue", "price 40 flips the verdict to continue")
ok(plan.chosen_scenario_id === "sc_1", "and chooses doing nothing")
await post("/assumptions/as_001", { value: null })
plan = await get("/plan")
ok(plan.decisions.continue_vs_change.verdict === "expand", "clearing the override restores expand")
const events = []
{
	const ac = new AbortController()
	setTimeout(() => ac.abort(), 400)
	try {
		const r = await fetch(`${base}/events?since=-1`, { signal: ac.signal })
		let buf = ""
		for await (const chunk of r.body) {
			buf += Buffer.from(chunk).toString()
			for (const m of buf.matchAll(/^data: (.*)$/gm)) events.push(JSON.parse(m[1]))
		}
	} catch { /* aborted on purpose */ }
}
const uniq = new Map(events.map((e) => [e.seq, e]))
const moved = [...uniq.values()].find((e) => e.type === "agent_reassigned")
ok(moved?.agent_id === "a_03" && moved.from_topic_id === "t_002" && moved.topic_id === "t_001", "stream carries the reassignment a_03: t_002 -> t_001")
ok([...uniq.values()].some((e) => e.type === "conflict_detected") && [...uniq.values()].some((e) => e.type === "plan_ready"), "stream carries a conflict and plan_ready")
console.log("demo-mode e2e passed")
server.kill()

