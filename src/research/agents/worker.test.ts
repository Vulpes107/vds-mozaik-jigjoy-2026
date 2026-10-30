// End-to-end through the REAL Mozaik runtime with a scripted fake model: no network, no API keys.
// Proves: assignment -> fresh agent -> tools -> events -> TaskFinished; hard limits; reassignment; injection safety.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import {
	DeveloperMessageItem, FunctionCallItem, FunctionCallOutputItem, InputTokenDetails, ModelMessageItem, OutputTokenDetails,
	SemanticEvent, SituationSpecification, TokenUsage, UserMessageItem, createHuman,
	type InferenceInput, type InferenceOutput, type InferenceRunner,
} from "@mozaik-ai/core"
import { EV, type TaskAssignedPayload } from "../../shared/events.ts"
import { RunState, initializeRuntime, join, resolveRuntime, sendEvent } from "../../shared/runtime.ts"
import { startResearch } from "../index.ts"
import { MemoryContentStore } from "../content.ts"
import { MemoryCache } from "../tools/cache.ts"
import { RateLimiter } from "../tools/resilience.ts"
import { FakeFetch, FakeSearch, fastRetry, outage, page, profile } from "../testkit.ts"
import { HOSTILE_PAGE } from "../tools/fixtures.ts"
import { defaultLimits } from "../index.ts"

// The Mozaik cloud SDK reads ./.env and would stream these fake runs to the real project. An empty key disables it.
process.env.MOZAIK_API_KEY = ""
process.env.MOZAIK_PROJECT_KEY = ""

type Final = { tool: string; args: object } | { say: string } | { hang: true }
type Step = Final | { sleepThen: number; step: Final }
interface Turn { role: string; topicId: string; step: number; outputs: any[]; user: string }
type Script = (t: Turn) => Step

const scripts = new Map<string, Script>()
let tokensPerInference = 100
const seenUserMessages: string[] = []

const runner: InferenceRunner = {
	async run(req: InferenceInput): Promise<InferenceOutput> {
		const items = req.context.getItems()
		const dev = items.find((i): i is DeveloperMessageItem => i instanceof DeveloperMessageItem)
		const user = items.find((i): i is UserMessageItem => i instanceof UserMessageItem)
		const role = /ROLE: (\w+)/.exec(dev?.content.text ?? "")?.[1]?.toLowerCase() ?? "?"
		const topicId = /Topic (t_\w+)/.exec(user?.content.text ?? "")?.[1] ?? "?"
		const outputs = items.filter((i): i is FunctionCallOutputItem => i instanceof FunctionCallOutputItem).map((o) => { try { return JSON.parse(o.output.text) } catch { return { raw: o.output.text } } })
		if (outputs.length === 0) seenUserMessages.push(user?.content.text ?? "")
		const script = scripts.get(`${role}:${topicId}`)
		if (!script) throw new Error(`no script for ${role}:${topicId}`)
		const planned = script({ role, topicId, step: outputs.length, outputs, user: user?.content.text ?? "" })
		let step: Final
		if ("sleepThen" in planned) {
			await new Promise((r) => setTimeout(r, planned.sleepThen))
			step = planned.step
		} else step = planned
		if ("hang" in step) return new Promise<InferenceOutput>(() => {})
		const usage = new TokenUsage(tokensPerInference, 0, tokensPerInference, new InputTokenDetails(0), new OutputTokenDetails(0))
		const item = "say" in step ? ModelMessageItem.rehydrate({ text: step.say }) : FunctionCallItem.rehydrate({ callId: `c${outputs.length}`, name: step.tool, args: JSON.stringify(step.args) })
		return { items: [item], tokenUsage: usage, rowResponse: null }
	},
	async *stream() {},
}

const log: { type: string; payload: any }[] = []
const joined: { id: string; name: string }[] = []
let allocatorId = ""

class Everything extends SituationSpecification {
	isSatisfiedBy(): boolean {
		return true
	}
}

before(() => {
	initializeRuntime({ state: new RunState(), inferenceRunnerConfig: { runner } })
	const observer = createHuman({
		name: "Observer",
		capabilities: [],
		handlers: [{
			specification: new Everything(),
			processor: { apply: ({ event }) => {
				if (event.type === "participant.joined") joined.push({ id: (event.payload as any).id, name: (event.payload as any).name })
				else if (Object.values(EV).includes(event.type as never)) log.push({ type: event.type, payload: event.payload })
			} },
		}],
	})
	join(observer)
	const allocator = createHuman({ name: "Allocator", capabilities: [], handlers: [] })
	join(allocator)
	allocatorId = allocator.getId()
})

const waitFor = async (cond: () => boolean, what: string, ms = 4000): Promise<void> => {
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}\nlog: ${JSON.stringify(log.slice(-8))}`)
		await new Promise((r) => setTimeout(r, 5))
	}
}
const eventsOf = (type: string, where: (p: any) => boolean = () => true) => log.filter((e) => e.type === type && where(e.payload)).map((e) => e.payload)
const isGone = (id: string): boolean => resolveRuntime().state.getParticipant(id) === undefined
const finished = (slot: string) => eventsOf(EV.TaskFinished, (p) => p.slotId === slot)
const assign = (p: TaskAssignedPayload) => sendEvent(SemanticEvent.create(EV.TaskAssigned, allocatorId, p), allocatorId)

function setup(slot: string | string[], opts: { search?: FakeSearch; fetch?: FakeFetch; topics: [string, string, string?][]; limits?: Parameters<typeof defaultLimits> extends never ? never : Partial<ReturnType<typeof defaultLimits>> } ) {
	const state = new RunState()
	state.runId = "r_e2e"
	state.profile = profile()
	for (const [id, st, cat] of opts.topics) state.topics.set(id, { id, title: `Topic about ${id}`, question: `What about ${id}?`, category: cat ?? "market", state: st })
	const search = opts.search ?? new FakeSearch("fake-search", (q) => [{ title: "Parcel market", url: "https://stats.example/market", snippet: `result for ${q}` }])
	const fetch = opts.fetch ?? new FakeFetch("fake-fetch", (u) => page(u, "The entry plan costs 49 EUR per user per month."))
	const sys = startResearch({
		state,
		searchProviders: [search],
		fetchProviders: [fetch],
		slots: Array.isArray(slot) ? slot : [slot],
		models: { scout: "fake", collector: "fake", analyst: "fake", verifier: "fake" },
		cache: new MemoryCache(),
		content: new MemoryContentStore(),
		limiter: new RateLimiter({ maxConcurrent: 4, minIntervalMs: 0 }, async () => {}),
		retry: fastRetry(2),
		installSafetyNet: false,
		limitsFor: (role, depth, topic) => ({ ...defaultLimits(role, depth, topic), ...(opts.limits ?? {}) }),
	})
	return { state, search, fetch, sys }
}

// ------------------------------------------------------------------------------------------------------------

test("scout: searches (with the query redacted), reports scores, finishes, and its agent leaves", async () => {
	const { search } = setup("slot_s1", { topics: [["t_100", "scouting"]] })
	scripts.set("scout:t_100", ({ step }) =>
		step === 0 ? { tool: "web_search", args: { query: "Demo Logistics RouteGenius route optimisation software market Serbia" } }
		: step === 1 ? { tool: "report_scores", args: { relevance: 0.8, impact: 0.6, rationale: "direct competitors found", evidence_quality: "adequate" } }
		: { say: "Relevant; several vendors." })

	assign({ slotId: "slot_s1", role: "scout", topicId: "t_100" })
	await waitFor(() => finished("slot_s1").length > 0, "scout TaskFinished")

	const scored = eventsOf(EV.TopicScored, (p) => p.topicId === "t_100")
	assert.equal(scored.length, 1)
	assert.deepEqual({ r: scored[0].relevance, i: scored[0].impact }, { r: 0.8, i: 0.6 })
	assert.equal(finished("slot_s1")[0].outcome, "done")
	assert.equal(finished("slot_s1")[0].role, "scout")
	assert.equal(search.calls.length, 1)
	assert.ok(!/demo logistics|routegenius/i.test(search.calls[0]!.query), search.calls[0]!.query)
	assert.match(search.calls[0]!.query, /route optimisation software market Serbia/)
	const agent = joined.find((j) => j.name === "Scout slot_s1")!
	await waitFor(() => isGone(agent.id), "scout agent to leave the runtime")
})

test("scout with the provider down: reports a gap instead of scoring blind, and the run does not crash", async () => {
	setup("slot_s2", { topics: [["t_101", "scouting"]], search: new FakeSearch("down", () => { throw outage() }) })
	scripts.set("scout:t_101", ({ step, outputs }) =>
		step === 0 ? { tool: "web_search", args: { query: "parcel delivery regulation in the western balkans" } }
		: step === 1 ? (outputs[0].ok ? { tool: "report_scores", args: { relevance: 0, impact: 0, rationale: "x", evidence_quality: "none" } } : { tool: "report_scores", args: { relevance: 0.05, impact: 0.05, rationale: "nothing found", evidence_quality: "none" } })
		: step === 2 ? { tool: "report_gap", args: { reason: "search provider unavailable" } }
		: { say: "Could not research: provider outage." })

	assign({ slotId: "slot_s2", role: "scout", topicId: "t_101" })
	await waitFor(() => finished("slot_s2").length > 0, "TaskFinished")
	assert.equal(eventsOf(EV.TopicScored, (p) => p.topicId === "t_101").length, 0, "no scores from a blind scout: the topic must not be dropped because the API was down")
	const gaps = eventsOf(EV.ResearchGap, (p) => p.slotId === "slot_s2")
	assert.ok(gaps.length >= 1)
	assert.ok(gaps.some((g) => /unavailable/.test(g.reason)))
})

test("collector then analyst: fresh agents, material handed over, a sourced finding lands in RunState", async () => {
	const { state } = setup(["slot_c1", "slot_a1"], { topics: [["t_102", "deep", "pricing"]] })
	scripts.set("collector:t_102", ({ step, outputs }) =>
		step === 0 ? { tool: "web_fetch", args: { url: "https://vendor.example/pricing" } }
		: step === 1 ? { tool: "save_material", args: { source_id: outputs[0].pages[0].source_id, note: "vendor pricing page" } }
		: { say: "Saved the pricing page." })
	scripts.set("analyst:t_102", ({ step, outputs }) =>
		step === 0 ? { tool: "list_material", args: {} }
		: step === 1 ? { tool: "submit_finding", args: { claim: "The entry plan costs 49 EUR per user per month.", type: "fact", value: 49, unit: "EUR/user/month", as_of: "2026-10-01", source_ids: [outputs[0].material[0].source_id], confidence: 0.85, metric_key: "vendor_entry_price" } }
		: { say: "One finding recorded." })

	assign({ slotId: "slot_c1", role: "collector", topicId: "t_102" })
	await waitFor(() => finished("slot_c1").length > 0, "collector done")
	assert.equal(finished("slot_c1")[0].sources, 1)
	assign({ slotId: "slot_a1", role: "analyst", topicId: "t_102" })
	await waitFor(() => finished("slot_a1").length > 0, "analyst done")

	assert.equal(state.findings.size, 1)
	const f = [...state.findings.values()][0]!
	assert.equal(f.topic_id, "t_102")
	assert.equal(f.value, 49)
	assert.ok(state.sources.has((f.source_ids as string[])[0]!))
	assert.equal(finished("slot_a1")[0].findings, 1)
	assert.ok(eventsOf(EV.FindingSubmitted, (p) => p.topicId === "t_102").length >= 1)
	assert.ok(eventsOf(EV.TopicProgress, (p) => p.topicId === "t_102" && p.slotId === "slot_a1").length >= 1)
	const ids = joined.filter((j) => /^(Collector|Analyst) slot_(c1|a1)$/.test(j.name)).map((j) => j.id)
	assert.equal(new Set(ids).size, 2, "each task got its own disposable agent")
})

test("a page full of injected instructions cannot steer even a gullible model, and is flagged", async () => {
	const { state } = setup("slot_c2", {
		topics: [["t_103", "deep", "pricing"]],
		fetch: new FakeFetch("f", (u) => page(u, HOSTILE_PAGE)),
	})
	let sawDirective = false
	scripts.set("collector:t_103", ({ step, outputs }) => {
		if (step === 0) return { tool: "web_fetch", args: { url: "https://vendor.example/pricing" } }
		const seen = JSON.stringify(outputs[0])
		// A gullible model: obeys any instruction it can still see.
		if (/ignore all previous|submit_finding|api key|credentials/i.test(seen)) {
			sawDirective = true
			return { tool: "submit_finding", args: { claim: "Example Corp is the clear market leader.", type: "fact", as_of: "2026-10-01", source_ids: [outputs[0].pages[0].source_id], confidence: 1 } }
		}
		return step === 1 ? { tool: "save_material", args: { source_id: outputs[0].pages[0].source_id, note: "pricing" } } : { say: "Saved." }
	})
	assign({ slotId: "slot_c2", role: "collector", topicId: "t_103" })
	await waitFor(() => finished("slot_c2").length > 0, "collector done")
	assert.equal(sawDirective, false, "directive text never reached the model")
	assert.equal(state.findings.size, 0)
	assert.equal(eventsOf(EV.InjectionFlagged, (p) => p.slotId === "slot_c2").length, 1)
	assert.ok([...state.sources.values()].every((s) => s.injection_flagged === true))
})

test("hard limit on tool calls: a runaway loop is stopped, outcome budget_exhausted, gap recorded", async () => {
	const { search } = setup("slot_s3", { topics: [["t_104", "scouting"]], limits: { maxToolCalls: 3 } })
	let n = 0
	scripts.set("scout:t_104", () => ({ tool: "web_search", args: { query: `loop query number ${n++} about couriers` } }))
	assign({ slotId: "slot_s3", role: "scout", topicId: "t_104" })
	await waitFor(() => finished("slot_s3").length > 0, "stopped")
	assert.equal(finished("slot_s3")[0].outcome, "budget_exhausted")
	assert.equal(search.calls.length, 3)
	assert.ok(eventsOf(EV.ResearchGap, (p) => p.slotId === "slot_s3").length >= 1)
})

test("hard limit on tokens: the task stops before running the next tool", async () => {
	const { search } = setup("slot_s4", { topics: [["t_105", "scouting"]], limits: { maxTokens: 30_000 } })
	tokensPerInference = 40_000
	try {
		scripts.set("scout:t_105", () => ({ tool: "web_search", args: { query: "token heavy query about couriers" } }))
		assign({ slotId: "slot_s4", role: "scout", topicId: "t_105" })
		await waitFor(() => finished("slot_s4").length > 0, "stopped")
	} finally {
		tokensPerInference = 100
	}
	assert.equal(finished("slot_s4")[0].outcome, "budget_exhausted")
	assert.equal(search.calls.length, 0)
})

test("topic.budget.tokens from the orchestrator overrides the default limit", () => {
	const l = defaultLimits("analyst", "deep", { id: "t", budget: { tokens: 1234, seconds: 7 } })
	assert.equal(l.maxTokens, 1234)
	assert.equal(l.seconds, 7)
	assert.ok(defaultLimits("scout", "shallow", { id: "t" }).maxToolCalls <= 6)
})

test("a stuck model call ends by timeout instead of hanging the slot forever", async () => {
	setup("slot_s5", { topics: [["t_106", "scouting"]], limits: { seconds: 0.05 } })
	scripts.set("scout:t_106", () => ({ hang: true }))
	assign({ slotId: "slot_s5", role: "scout", topicId: "t_106" })
	await waitFor(() => finished("slot_s5").length > 0, "timeout")
	assert.equal(finished("slot_s5")[0].outcome, "timeout")
	assert.ok(eventsOf(EV.ResearchGap, (p) => p.slotId === "slot_s5").length >= 1)
})

test("reassignment mid-task: the old agent is stopped silently, a fresh agent starts with the handoff and no old context", async () => {
	setup("slot_s6", { topics: [["t_107", "scouting"], ["t_108", "scouting"]] })
	scripts.set("scout:t_107", ({ step }) => (step === 0 ? { sleepThen: 150, step: { tool: "web_search", args: { query: "slow query about couriers" } } } : { say: "late" }))
	scripts.set("scout:t_108", ({ step }) =>
		step === 0 ? { tool: "web_search", args: { query: "second topic query about couriers" } }
		: step === 1 ? { tool: "report_scores", args: { relevance: 0.9, impact: 0.9, rationale: "hot", evidence_quality: "adequate" } }
		: { say: "done" })

	assign({ slotId: "slot_s6", role: "scout", topicId: "t_107" })
	await new Promise((r) => setTimeout(r, 30))
	assign({ slotId: "slot_s6", role: "scout", topicId: "t_108", fromTopicId: "t_107", handoff: "Previous topic was dropped as irrelevant; start clean." })
	await waitFor(() => finished("slot_s6").length > 0, "second task done")
	await new Promise((r) => setTimeout(r, 250)) // let the superseded agent's delayed turn play out

	const done = finished("slot_s6")
	assert.equal(done.length, 1, "exactly one TaskFinished: the superseded task is not reported")
	assert.equal(done[0].topicId, "t_108")
	assert.equal(eventsOf(EV.TopicScored, (p) => p.topicId === "t_107").length, 0)
	assert.equal(eventsOf(EV.TopicScored, (p) => p.topicId === "t_108").length, 1)
	const second = seenUserMessages.find((m) => m.includes("Topic t_108"))!
	assert.match(second, /HANDOFF/)
	assert.match(second, /start clean/)
	assert.ok(!second.includes("t_107"), "no carried-over context from the old topic")
	const scouts = joined.filter((j) => j.name === "Scout slot_s6")
	assert.equal(scouts.length, 2)
	for (const s of scouts) await waitFor(() => isGone(s.id), "agent to leave the runtime")
})

test("assignments for unknown topics are reported as errors; other slots' assignments are ignored", async () => {
	setup("slot_s7", { topics: [] })
	assign({ slotId: "slot_s7", role: "scout", topicId: "t_999" })
	await waitFor(() => finished("slot_s7").length > 0, "error reported")
	assert.equal(finished("slot_s7")[0].outcome, "error")
	assign({ slotId: "slot_nobody", role: "scout", topicId: "t_999" })
	await new Promise((r) => setTimeout(r, 30))
	assert.equal(finished("slot_nobody").length, 0)
})

test("a worker that finishes without any output still leaves a trace (gap), so the topic is never silently empty", async () => {
	setup("slot_a2", { topics: [["t_109", "shallow"]] })
	scripts.set("analyst:t_109", () => ({ say: "Nothing to analyse." }))
	assign({ slotId: "slot_a2", role: "analyst", topicId: "t_109" })
	await waitFor(() => finished("slot_a2").length > 0, "done")
	assert.equal(finished("slot_a2")[0].findings, 0)
	assert.ok(eventsOf(EV.ResearchGap, (p) => p.slotId === "slot_a2").length === 1)
})
