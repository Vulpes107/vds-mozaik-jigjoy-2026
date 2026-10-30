// Runs the Planner on a profile with auto-approval and prints the AgentEvent stream and the board. Usage:
//   node --env-file=.env --import tsx src/orchestrator/demo.ts [mocks/company_profile.sample.json]
import { readFileSync } from "node:fs"
import { onAgentEvent } from "./cartographer.ts"
import { startRun } from "./run.ts"

const profile = JSON.parse(readFileSync(process.argv[2] ?? "mocks/company_profile.sample.json", "utf8"))
onAgentEvent((e) => {
	console.log(`#${e.seq} ${e.type} ${e.agent_id ?? ""} ${e.topic_id ?? ""} ${e.detail ?? ""}`.trimEnd())
	if (e.type === "agent_assigned") {
		// Without research workers (Machine B) the run stops here: print the board and exit.
		for (const t of state.topics.values()) console.log(`  ${t.id} ${String(t.importance_prior).padEnd(4)} ${String(t.category).padEnd(18)} ${String(t.state).padEnd(9)} ${t.title}`)
		process.exit(0)
	}
})
const state = startRun(profile, { autoApprove: true })
