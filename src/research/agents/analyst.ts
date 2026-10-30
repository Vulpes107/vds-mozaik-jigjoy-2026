import { type Agent, createAgent } from "@mozaik-ai/core"
import { instructionFor } from "../prompts.ts"
import { readMaterialTools, reportGapTool, submitFindingTool, submitSourceTool, suggestTopicTool } from "../submit-tools.ts"
import { webTools } from "../tools/web-tools.ts"
import type { WorkerContext } from "./context.ts"

/** Turns collected material into Findings. Light web access to close a specific hole, nothing more. */
export function makeAnalyst({ deps, scope }: WorkerContext): Agent {
	const ctx = { scope, store: deps.store, library: deps.library }
	return createAgent({
		name: `Analyst ${scope.slotId}`,
		capabilities: ["inference", "analysis"],
		instruction: instructionFor("analyst", deps.store.today()),
		tools: [...readMaterialTools(ctx), ...webTools(deps.gateway, scope), submitFindingTool(ctx), submitSourceTool(ctx), suggestTopicTool(ctx), reportGapTool(ctx)],
		handlers: [],
	})
}
