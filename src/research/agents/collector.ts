import { type Agent, createAgent } from "@mozaik-ai/core"
import { instructionFor } from "../prompts.ts"
import { reportGapTool, saveMaterialTool, submitSourceTool } from "../submit-tools.ts"
import { extraTools, webTools } from "../tools/web-tools.ts"
import type { WorkerContext } from "./context.ts"

/**
 * Deep gathering. Declares an optional dependency on provider extras (map/crawl/research); when the configured
 * provider lacks them those tools answer "unsupported" and the agent degrades to web_search + web_fetch.
 */
export function makeCollector({ deps, scope }: WorkerContext): Agent {
	const ctx = { scope, store: deps.store, library: deps.library }
	return createAgent({
		name: `Collector ${scope.slotId}`,
		capabilities: ["inference", "web_search", "web_fetch"],
		instruction: instructionFor("collector", deps.store.today()),
		tools: [...webTools(deps.gateway, scope), ...extraTools(deps.gateway, scope), saveMaterialTool(ctx), submitSourceTool(ctx), reportGapTool(ctx)],
		handlers: [],
	})
}
