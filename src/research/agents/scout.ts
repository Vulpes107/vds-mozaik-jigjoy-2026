import { type Agent, createAgent } from "@mozaik-ai/core"
import { instructionFor } from "../prompts.ts"
import { reportGapTool, reportScoresTool } from "../submit-tools.ts"
import { webTools } from "../tools/web-tools.ts"
import type { WorkerContext } from "./context.ts"

/** Cheap breadth pass: search only (no fetch), then report relevance/impact. */
export function makeScout({ deps, scope }: WorkerContext): Agent {
	const ctx = { scope, store: deps.store, library: deps.library }
	const [search] = webTools(deps.gateway, scope)
	return createAgent({
		name: `Scout ${scope.slotId}`,
		capabilities: ["inference", "web_search"],
		instruction: instructionFor("scout", deps.store.today()),
		tools: [search!, reportScoresTool(ctx), reportGapTool(ctx)],
		handlers: [],
	})
}
