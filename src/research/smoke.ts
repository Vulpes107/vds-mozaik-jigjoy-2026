// Manual smoke run of the research team against REAL Tavily and a REAL model (costs credits; streams to Mozaik cloud).
//   node --env-file=.env --import tsx src/research/smoke.ts [topic_index]
// Needs TAVILY_API_KEY and the provider key of the models in config/models.json. It stands in for Machine A's
// Allocator: it assigns scout -> collector -> analyst -> verifier on one topic from mocks/ and prints what came out.
import { readFileSync } from "node:fs"
import { SemanticEvent, SituationSpecification, createHuman } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { type Obj, join, sendEvent, startRuntime } from "../shared/runtime.ts"
import { startResearch, tavilyWithFallbacks } from "./index.ts"

const mock = (name: string) => JSON.parse(readFileSync(new URL(`../../mocks/${name}`, import.meta.url), "utf8"))

if (!process.env.TAVILY_API_KEY) {
	console.error("TAVILY_API_KEY is not set. Add it to .env (each machine uses its own key) and run with --env-file=.env.")
	process.exit(1)
}

const state = startRuntime("r_smoke")
state.profile = mock("company_profile.sample.json")
const topics = mock("topic.sample.json") as Obj[]
const topic: Obj = { ...topics[Number(process.argv[2] ?? 0)]!, state: "deep" }
state.topics.set(topic.id, topic)
state.runBudget = { calls: 60 }

// Free/accountless fallbacks (Parallel, You.com, Firecrawl) back up Tavily if it's rate-limited.
const { searchProviders, fetchProviders, extras } = tavilyWithFallbacks()
const system = startResearch({ state, searchProviders, fetchProviders, extras, slots: ["slot_1"] })

const done = new Map<string, (p: Record<string, unknown>) => void>()
class All extends SituationSpecification {
	isSatisfiedBy(): boolean {
		return true
	}
}
const allocator = createHuman({
	name: "SmokeAllocator",
	capabilities: [],
	handlers: [{
		specification: new All(),
		processor: { apply: ({ event }) => {
			if (!(Object.values(EV) as string[]).includes(event.type) || event.type === EV.TaskAssigned) return
			const p = event.payload as Record<string, unknown>
			console.log(`  [${event.type}]`, JSON.stringify(p).slice(0, 220))
			if (event.type === EV.TaskFinished) done.get(String(p.role))?.(p)
		} },
	}],
})
join(allocator)

for (const role of ["scout", "collector", "analyst", "verifier"] as const) {
	console.log(`\n== ${role} on ${topic.id}: ${topic.title}`)
	const finished = new Promise<Record<string, unknown>>((resolve) => done.set(role, resolve))
	sendEvent(SemanticEvent.create(EV.TaskAssigned, allocator.getId(), { slotId: "slot_1", role, topicId: topic.id }), allocator.getId())
	const result = await finished
	console.log(`   -> ${result.outcome}: ${String(result.summary ?? "").slice(0, 300)}`)
}

console.log(`\nFindings: ${state.findings.size}, sources: ${state.sources.size}`)
for (const f of state.findings.values()) console.log(` - ${f.id} [${f.type}${f.verified ? ", verified" : ""}] conf ${f.confidence}: ${String(f.claim).slice(0, 140)}`)
console.log("Usage:", JSON.stringify(system.meter.summary()), `provider calls: ${system.budget.totalUsed}`)
process.exit(0)
