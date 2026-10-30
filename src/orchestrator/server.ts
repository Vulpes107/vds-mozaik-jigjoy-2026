// REST + SSE API for the dashboard (ADR 0001). One process hosts one run.
//   node --env-file=.env --import tsx src/orchestrator/server.ts   (PORT, default 8787)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Obj, RunState } from "../shared/runtime.ts"
import { onAgentEvent } from "./cartographer.ts"
import { resolveCheckpoint } from "./operator.ts"
import { overrideAssumption, startRun, type RunOptions } from "./run.ts"
import { runStatus } from "./snapshot.ts"
import { openStore } from "./store.ts"

let state: RunState | undefined

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
	res.end(JSON.stringify(body))
}
async function body(req: IncomingMessage): Promise<unknown> {
	let s = ""
	for await (const c of req) s += c
	return s ? JSON.parse(s) : {}
}
export function handle(req: IncomingMessage, res: ServerResponse): void {
	void (async () => {
		const url = new URL(req.url ?? "/", "http://x")
		const parts = url.pathname.split("/").filter(Boolean) // ["runs", id, ...]
		if (req.method === "OPTIONS") return json(res, 204, {})
		if (req.method === "POST" && parts.length === 1 && parts[0] === "runs") {
			if (state) return json(res, 409, { error: "a run is already live in this process", run_id: state.runId })
			const b = (await body(req)) as { profile?: Obj } & RunOptions
			if (!b.profile) return json(res, 400, { error: "body must be { profile: CompanyProfile, auto_approve?, slots? }" })
			try {
				state = startRun(b.profile, {
					autoApprove: b.autoApprove ?? (b as { auto_approve?: boolean }).auto_approve,
					slots: b.slots,
					planner: b.planner,
					...(b.research === false ? { research: false as const } : {}),
				})
			} catch (e) {
				return json(res, 400, { error: String(e) })
			}
			return json(res, 201, { run_id: state.runId })
		}
		if (req.method === "GET" && parts.length === 1 && parts[0] === "runs") {
			const project = url.searchParams.get("project_id") ?? undefined
			return json(res, 200, openStore().list(project))
		}
		if (parts[0] !== "runs" || !state || parts[1] !== state.runId) return json(res, 404, { error: "not found" })
		const s = state
		const rest = parts.slice(2)
		if (req.method === "GET" && rest.length === 0) {
			return json(res, 200, { run_id: s.runId, project_id: s.profile?.project_id, status: runStatus(s), profile: s.profile, budget: s.runBudget, spent: s.spent, topics: s.topics.size, slots: Object.fromEntries(s.slots), checkpoints: [...s.checkpoints.values()] })
		}
		if (req.method === "GET" && rest[0] === "topics") return json(res, 200, [...s.topics.values()])
		if (req.method === "GET" && rest[0] === "findings") return json(res, 200, [...s.findings.values()])
		if (req.method === "GET" && rest[0] === "sources") return json(res, 200, [...s.sources.values()])
		if (req.method === "GET" && rest[0] === "assumptions") return json(res, 200, [...s.assumptions.values()])
		if (req.method === "GET" && rest[0] === "scenarios") return json(res, 200, [...s.scenarios.values()])
		if (req.method === "POST" && rest[0] === "assumptions" && rest[1]) {
			if (!s.assumptions.has(rest[1])) return json(res, 404, { error: "unknown assumption" })
			const b = (await body(req)) as { value?: number | null }
			if (b.value !== null && typeof b.value !== "number") return json(res, 400, { error: "body must be { value: number | null }" })
			overrideAssumption(rest[1], b.value ?? null)
			return json(res, 202, { assumption_id: rest[1], value: b.value ?? null })
		}
		if (req.method === "GET" && rest[0] === "plan") return s.plan ? json(res, 200, s.plan) : json(res, 404, { error: "plan not ready" })
		if (req.method === "POST" && rest[0] === "checkpoints" && rest[1]) {
			const b = (await body(req)) as { approved?: boolean }
			const ok = resolveCheckpoint(rest[1], b.approved !== false)
			return ok ? json(res, 200, s.checkpoints.get(rest[1])) : json(res, 404, { error: "no pending checkpoint with that id" })
		}
		if (req.method === "GET" && rest[0] === "events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" })
			const send = (e: Obj) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? -1)
			for (const e of s.agentEvents) if ((e.seq as number) > since) send(e)
			const off = onAgentEvent(send)
			const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000)
			req.on("close", () => {
				off()
				clearInterval(beat)
			})
			return
		}
		return json(res, 404, { error: "not found" })
	})().catch((e) => json(res, 500, { error: String(e) }))
}

/** For tests: forget the live run (the Mozaik runtime itself cannot be re-initialised in-process). */
export function _resetForTests(s?: RunState) {
	state = s
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const port = Number(process.env.PORT ?? 8787)
	// Localhost only: no auth, and every run spends the team's LLM budget.
	createServer(handle).listen(port, "127.0.0.1", () => console.log(`orchestrator API on http://localhost:${port}`))
}
