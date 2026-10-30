import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentEvent, Assumption, BusinessPlan, CompanyProfile, Finding, Scenario, Source, Topic } from "./types/contracts.ts"

/** Same origin by default: Vite proxies `/runs` to the orchestrator (see vite.config.ts). */
export const API = (import.meta.env.VITE_API_URL as string | undefined) ?? ""
const params = new URLSearchParams(location.search)
/** `?run=<id>` / `VITE_RUN_ID`, else the newest run listed by `GET /runs` (resolved on first load). */
export let RUN_ID = params.get("run") ?? (import.meta.env.VITE_RUN_ID as string | undefined) ?? ""
/** `?ro=1` is the read-only share view: no assumption editing, no checkpoint buttons. */
export const READ_ONLY = params.get("ro") === "1"

export interface Checkpoint {
	id: string
	kind: string
	status: "pending" | "approved" | "rejected"
}
export interface RunSummary {
	run_id: string
	status: string
	profile?: CompanyProfile
	budget?: { usd?: number; seconds?: number; tokens?: number; calls?: number }
	spent?: { usd?: number; seconds?: number; tokens?: number; calls?: number }
	checkpoints?: Checkpoint[]
}
export type Conn = "loading" | "live" | "reconnecting" | "offline"

export interface RunData {
	conn: Conn
	error?: string
	run?: RunSummary
	topics: Topic[]
	findings: Finding[]
	sources: Source[]
	assumptions: Assumption[]
	scenarios: Scenario[]
	plan?: BusinessPlan
	events: AgentEvent[]
}

async function get<T>(path: string): Promise<T | undefined> {
	const r = await fetch(`${API}/runs/${RUN_ID}${path}`)
	if (r.status === 404) return undefined
	if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
	return (await r.json()) as T
}
async function post(path: string, body: unknown): Promise<void> {
	const r = await fetch(`${API}/runs/${RUN_ID}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
	if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
}

const empty: RunData = { conn: "loading", topics: [], findings: [], sources: [], assumptions: [], scenarios: [], events: [] }

/** REST snapshot + SSE stream. EventSource resends Last-Event-ID on reconnect, so no event is lost or duplicated (deduped by seq). */
export function useRun() {
	const [data, setData] = useState<RunData>(empty)
	const timer = useRef<number>()

	const load = useCallback(async () => {
		try {
			if (!RUN_ID) {
				const r = await fetch(`${API}/runs`)
				if (!r.ok) throw new Error(`/runs: HTTP ${r.status}`)
				RUN_ID = ((await r.json()) as { run_id: string }[])[0]?.run_id ?? ""
				if (!RUN_ID) throw new Error("no run yet")
			}
			const [run, topics, findings, sources, assumptions, scenarios, plan] = await Promise.all([
				get<RunSummary>(""),
				get<Topic[]>("/topics"),
				get<Finding[]>("/findings"),
				get<Source[]>("/sources"),
				get<Assumption[]>("/assumptions"),
				get<Scenario[]>("/scenarios"),
				get<BusinessPlan>("/plan"),
			])
			if (!run) throw new Error(`Run ${RUN_ID} not found`)
			setData((d) => ({ ...d, conn: d.conn === "reconnecting" ? "reconnecting" : "live", error: undefined, run, topics: topics ?? [], findings: findings ?? [], sources: sources ?? [], assumptions: assumptions ?? [], scenarios: scenarios ?? [], plan }))
		} catch (e) {
			setData((d) => ({ ...d, conn: "offline", error: (e as Error).message }))
		}
	}, [])

	const refreshSoon = useCallback(() => {
		window.clearTimeout(timer.current)
		timer.current = window.setTimeout(load, 350)
	}, [load])

	useEffect(() => {
		let es: EventSource | undefined
		let gone = false
		// The stream opens once the run id is known (the first load may have to look it up).
		void load().then(() => {
			if (gone || !RUN_ID) return
			es = new EventSource(`${API}/runs/${RUN_ID}/events`)
			es.onopen = () => setData((d) => (d.conn === "offline" ? d : { ...d, conn: "live" }))
			es.onerror = () => setData((d) => ({ ...d, conn: d.run ? "reconnecting" : "offline" }))
			const onEvent = (m: MessageEvent) => {
				const e = JSON.parse(m.data as string) as AgentEvent
				setData((d) => (d.events.some((x) => x.seq === e.seq && e.seq !== undefined) ? d : { ...d, conn: d.conn === "reconnecting" ? "live" : d.conn, events: [...d.events, e] }))
				refreshSoon()
			}
			// The server names SSE events by type; listen to all contract types.
			for (const t of EVENT_TYPES) es.addEventListener(t, onEvent as EventListener)
		})
		return () => {
			gone = true
			es?.close()
			window.clearTimeout(timer.current)
		}
	}, [load, refreshSoon])

	const overrideAssumption = useCallback(
		async (id: string, value: number | null) => {
			setData((d) => ({ ...d, assumptions: d.assumptions.map((a) => (a.id === id ? { ...a, user_override: value } : a)) }))
			await post(`/assumptions/${id}`, { value })
			window.setTimeout(load, 700) // recompute is async on the server
		},
		[load],
	)
	const resolveCheckpoint = useCallback(
		async (id: string, approved: boolean) => {
			await post(`/checkpoints/${id}`, { approved })
			await load()
		},
		[load],
	)
	return { data, overrideAssumption, resolveCheckpoint, reload: load }
}

/** `POST /runs` with a CompanyProfile; the server validates it and answers 409 if it already hosts a run. */
export async function startRun(profile: CompanyProfile): Promise<string> {
	const r = await fetch(`${API}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile }) })
	const b = (await r.json()) as { run_id?: string; error?: string }
	if (!r.ok || !b.run_id) throw new Error(b.error ?? `POST /runs: HTTP ${r.status}`)
	return b.run_id
}

const EVENT_TYPES: AgentEvent["type"][] = [
	"run_started", "run_paused", "run_completed", "run_failed", "topics_proposed", "topic_approved", "topic_state_changed", "topic_dropped",
	"agent_spawned", "agent_assigned", "agent_reassigned", "agent_idle", "agent_failed", "finding_added", "finding_verified", "conflict_detected",
	"source_added", "injection_flagged", "budget_warning", "budget_exhausted", "analysis_started", "scenario_computed", "plan_ready",
	"checkpoint_requested", "checkpoint_resolved",
]
