// REST + SSE API for the dashboard (ADR 0001). One worker process hosts one live run; earlier runs are
// served read-only from their snapshots. A supervisor owns the port and swaps the worker when a run is
// finished or stopped and a new one is requested (the Mozaik runtime cannot be re-initialised in-process).
//   node --env-file=.env --import tsx src/orchestrator/server.ts   (PORT, default 8787)
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http"
import { parseEnv } from "node:util"
import { RunState, type Obj } from "../shared/runtime.ts"
import { onAgentEvent } from "./cartographer.ts"
import { resolveCheckpoint } from "./operator.ts"
import { overrideAssumption, startRun, stopRun, type RunOptions } from "./run.ts"
import { readSnapshot, restore, runStatus } from "./snapshot.ts"
import { openStore } from "./store.ts"

// Node's --env-file never overrides a variable the shell already exports, even an empty one (some terminals export
// ANTHROPIC_API_KEY=""); a blank key makes every model call fail and the run stops at once. Let .env fill such blanks.
if (existsSync(".env")) for (const [k, v] of Object.entries(parseEnv(readFileSync(".env", "utf8")))) if (!process.env[k]) process.env[k] = v

let state: RunState | undefined
const archive = new Map<string, RunState>()
const REPLACE = "x-swarm-replace"

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
	res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", ...headers })
	res.end(JSON.stringify(body))
}
async function body(req: IncomingMessage): Promise<unknown> {
	let s = ""
	for await (const c of req) s += c
	return s ? JSON.parse(s) : {}
}
/** A run that is not live in this process, rebuilt read-only from its snapshot (ADR 0002). */
function archived(id: string): RunState | undefined {
	if (!archive.has(id)) {
		try {
			archive.set(id, restore(new RunState(), readSnapshot(id)))
		} catch {
			return undefined
		}
	}
	return archive.get(id)
}
const finished = (s: RunState) => ["done", "stopped"].includes(runStatus(s))

export function handle(req: IncomingMessage, res: ServerResponse): void {
	void (async () => {
		const url = new URL(req.url ?? "/", "http://x")
		const parts = url.pathname.split("/").filter(Boolean) // ["runs", id, ...]
		if (req.method === "OPTIONS") return json(res, 204, {})
		if (req.method === "POST" && parts.length === 1 && parts[0] === "runs") {
			if (state && !finished(state)) return json(res, 409, { error: `run ${state.runId} is still in progress; stop it first`, run_id: state.runId })
			// Finished: this worker cannot host another run. The supervisor swaps the worker and re-sends the request.
			if (state) return json(res, 409, { error: "a finished run occupies this worker; restart the server", run_id: state.runId }, { [REPLACE]: "1" })
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
		const s = parts[0] === "runs" && parts[1] ? (parts[1] === state?.runId ? state : archived(parts[1])) : undefined
		if (!s) return json(res, 404, { error: "not found" })
		const live = s === state
		const rest = parts.slice(2)
		if (req.method === "GET" && rest.length === 0) {
			return json(res, 200, { run_id: s.runId, project_id: s.profile?.project_id, status: runStatus(s), live, profile: s.profile, budget: s.runBudget, spent: s.spent, topics: s.topics.size, slots: Object.fromEntries(s.slots), checkpoints: [...s.checkpoints.values()] })
		}
		if (req.method === "GET" && rest[0] === "topics") return json(res, 200, [...s.topics.values()])
		if (req.method === "GET" && rest[0] === "findings") return json(res, 200, [...s.findings.values()])
		if (req.method === "GET" && rest[0] === "sources") return json(res, 200, [...s.sources.values()])
		if (req.method === "GET" && rest[0] === "assumptions") return json(res, 200, [...s.assumptions.values()])
		if (req.method === "GET" && rest[0] === "scenarios") return json(res, 200, [...s.scenarios.values()])
		if (req.method === "GET" && rest[0] === "plan") return s.plan ? json(res, 200, s.plan) : json(res, 404, { error: "plan not ready" })
		if (req.method === "GET" && rest[0] === "events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" })
			const send = (e: Obj) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			const since = Number(req.headers["last-event-id"] ?? url.searchParams.get("since") ?? -1)
			for (const e of s.agentEvents) if ((e.seq as number) > since) send(e)
			const off = live ? onAgentEvent(send) : () => {}
			const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000)
			req.on("close", () => {
				off()
				clearInterval(beat)
			})
			return
		}
		if (req.method === "POST" && !live) return json(res, 409, { error: "run is not live; it is read-only" })
		if (req.method === "POST" && rest[0] === "assumptions" && rest[1]) {
			if (!s.assumptions.has(rest[1])) return json(res, 404, { error: "unknown assumption" })
			const b = (await body(req)) as { value?: number | null }
			if (b.value !== null && typeof b.value !== "number") return json(res, 400, { error: "body must be { value: number | null }" })
			overrideAssumption(rest[1], b.value ?? null)
			return json(res, 202, { assumption_id: rest[1], value: b.value ?? null })
		}
		if (req.method === "POST" && rest[0] === "checkpoints" && rest[1]) {
			const b = (await body(req)) as { approved?: boolean }
			const ok = resolveCheckpoint(rest[1], b.approved !== false)
			return ok ? json(res, 200, s.checkpoints.get(rest[1])) : json(res, 404, { error: "no pending checkpoint with that id" })
		}
		if (req.method === "POST" && rest[0] === "stop" && rest.length === 1) {
			if (!finished(s)) {
				stopRun("stopped by user")
				await new Promise((r) => setTimeout(r, 500)) // the debounced snapshot (200 ms) must land before the worker goes
			}
			return json(res, 202, { run_id: s.runId, status: runStatus(s) }, { [REPLACE]: "1" })
		}
		return json(res, 404, { error: "not found" })
	})().catch((e) => json(res, 500, { error: String(e) }))
}

/** For tests: forget the live run (the Mozaik runtime itself cannot be re-initialised in-process). */
export function _resetForTests(s?: RunState) {
	state = s
	archive.clear()
}

const freePort = () =>
	new Promise<number>((r) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port
			s.close(() => r(p))
		})
	})

/** Owns the public port; proxies to one worker (this same script with SWARM_WORKER=1) and replaces it when a response carries the REPLACE header. */
async function supervise(port: number) {
	let worker: ChildProcess | undefined
	let wport = 0
	const start = async () => {
		worker?.kill()
		wport = await freePort()
		worker = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, SWARM_WORKER: "1", PORT: String(wport) } })
		for (let i = 0; i < 100; i++) {
			await new Promise((r) => setTimeout(r, 100))
			if (await fetch(`http://127.0.0.1:${wport}/runs`).then((r) => r.ok, () => false)) return
		}
		throw new Error("worker did not start")
	}
	const forward = (req: IncomingMessage, payload: Buffer, res: ServerResponse, swap = true) => {
		const up = request({ host: "127.0.0.1", port: wport, path: req.url, method: req.method, headers: req.headers }, (r) => {
			if (!r.headers[REPLACE] || !swap) {
				res.writeHead(r.statusCode ?? 502, r.headers)
				r.pipe(res)
				return
			}
			const chunks: Buffer[] = []
			r.on("data", (c: Buffer) => chunks.push(c))
			r.on("end", () => {
				void start().then(
					() => (req.method === "POST" && req.url === "/runs" ? forward(req, payload, res, false) : json(res, r.statusCode ?? 202, JSON.parse(Buffer.concat(chunks).toString() || "{}"))),
					(e) => json(res, 503, { error: String(e) }),
				)
			})
		})
		up.on("error", (e) => json(res, 502, { error: String(e) }))
		up.end(payload)
	}
	await start()
	createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => forward(req, Buffer.concat(chunks), res))
	}).listen(port, "127.0.0.1", () => console.log(`orchestrator API on http://localhost:${port}`))
	process.on("exit", () => worker?.kill())
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const port = Number(process.env.PORT ?? 8787)
	// Localhost only: no auth, and every run spends the team's LLM budget.
	if (process.env.SWARM_WORKER) createServer(handle).listen(port, "127.0.0.1")
	else void supervise(port)
}
