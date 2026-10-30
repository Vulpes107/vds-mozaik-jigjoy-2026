// Runs the Planner on a profile and prints the board. Usage:
//   node --env-file=.env --import tsx src/orchestrator/demo.ts [mocks/company_profile.sample.json]
import { readFileSync } from "node:fs"
import { SemanticEvent, SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { join, sendEvent, startRuntime } from "../shared/runtime.ts"
import { validate } from "../shared/validate.ts"
import { startPlanner } from "./planner.ts"

const profile = JSON.parse(readFileSync(process.argv[2] ?? "mocks/company_profile.sample.json", "utf8"))
const err = validate("company_profile", profile)
if (err) throw new Error(`invalid profile:\n${err}`)

const state = startRuntime(`r_${Date.now().toString(36)}`)
state.profile = profile

class Any extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext): boolean {
		return !event.type.startsWith("inference.stream")
	}
}
const log = createHuman({
	name: "Log",
	capabilities: [],
	handlers: [
		{
			specification: new Any(),
			processor: {
				apply: ({ event }) => {
					console.log(`[${event.type}]`, event.type === EV.TopicsProposed ? JSON.stringify(event.payload) : "")
					if (event.type === EV.TopicsProposed) {
						for (const t of state.topics.values()) console.log(`  ${t.id} ${String(t.importance_prior).padEnd(4)} ${t.category}  ${t.title}`)
						process.exit(0)
					}
				},
			},
		},
	],
})
join(log)
startPlanner()
sendEvent(SemanticEvent.create(EV.RunStarted, log.getId(), { runId: state.runId }), log.getId())
