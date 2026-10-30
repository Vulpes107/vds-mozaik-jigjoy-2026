// Runs a whole pass on a profile with auto-approval and prints the AgentEvent stream, then the plan. Usage:
//   node --env-file=.env --import tsx src/orchestrator/demo.ts [mocks/company_profile.sample.json] [usd] [seconds]
import { readFileSync } from "node:fs"
import { onAgentEvent } from "./cartographer.ts"
import { startRun } from "./run.ts"
import { writeSnapshot } from "./snapshot.ts"

const profile = JSON.parse(readFileSync(process.argv[2] ?? "mocks/company_profile.sample.json", "utf8"))
profile.run_budget ??= { usd: Number(process.argv[3] ?? 1.5), seconds: Number(process.argv[4] ?? 900) }
const t0 = Date.now()

onAgentEvent((e) => {
	console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s #${e.seq} ${e.type} ${e.agent_id ?? ""} ${e.topic_id ?? ""} ${e.detail ?? ""}`.trimEnd())
	if (e.type === "plan_ready" || e.type === "run_completed") {
		const counts: Record<string, number> = {}
		for (const t of state.topics.values()) counts[String(t.state)] = (counts[String(t.state)] ?? 0) + 1
		console.log("\ntopics:", JSON.stringify(counts), "findings:", state.findings.size, "sources:", state.sources.size, "assumptions:", state.assumptions.size, "scenarios:", state.scenarios.size)
		console.log("spent:", JSON.stringify(state.spent), "snapshot:", writeSnapshot(state))
		const plan = state.plan as { executive_summary?: string; recommendations?: { title: string }[]; decisions?: { continue_vs_change?: { verdict?: string } } } | undefined
		if (plan) {
			console.log("\nverdict:", plan.decisions?.continue_vs_change?.verdict)
			console.log("summary:", plan.executive_summary)
			for (const r of plan.recommendations ?? []) console.log(" -", r.title)
		}
		process.exit(0)
	}
})
const state = startRun(profile, { autoApprove: true })
