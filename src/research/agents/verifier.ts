import { type Agent, createAgent } from "@mozaik-ai/core"
import { instructionFor } from "../prompts.ts"
import { reportGapTool, submitFindingTool, submitSourceTool, verifierTools } from "../submit-tools.ts"
import { webTools } from "../tools/web-tools.ts"
import type { WorkerContext } from "./context.ts"

/** Second independent source for high-impact findings. Independence is enforced in ResearchStore.verify. */
export function makeVerifier({ deps, scope }: WorkerContext): Agent {
	const ctx = { scope, store: deps.store, library: deps.library }
	return createAgent({
		name: `Verifier ${scope.slotId}`,
		capabilities: ["inference", "web_search", "web_fetch"],
		instruction: instructionFor("verifier", deps.store.today()),
		tools: [...verifierTools(ctx), ...webTools(deps.gateway, scope), submitFindingTool(ctx), submitSourceTool(ctx), reportGapTool(ctx)],
		handlers: [],
	})
}
