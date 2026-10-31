// Per-topic / per-run budget enforcement inside an agent loop (MASTERPLAN §10b):
// pass `budgetInterceptor(topicId)` as the 4th argument of runLoop. When a budget line is
// exhausted, the next inference or tool call is rewritten to a final model message, so the
// loop ends cleanly and the worker emits task.finished as usual.
import { ModelMessageItem, type ExecutableTransition, type InterceptionHandler } from "@mozaik-ai/core"
import type { Budget } from "../shared/runtime.ts"
import { resolveRuntime } from "../shared/runtime.ts"
import { researchBudget } from "./allocator.ts"

const LINES = ["tokens", "calls", "usd", "seconds"] as const

/** First exhausted budget line, or null. Pure; used by the interceptor and by tests. */
export function exhaustedLine(spent: Partial<Budget> | undefined, budget: Budget | undefined): string | null {
	for (const k of LINES) {
		const limit = budget?.[k]
		if (limit && (spent?.[k] ?? 0) >= limit) return k
	}
	return null
}

export const STOP_MESSAGE = "Budget exhausted for this task. Stopping here; findings submitted so far stand."

export function budgetInterceptor(topicId: string): InterceptionHandler {
	const why = (): string | null => {
		const s = resolveRuntime().state
		const run = exhaustedLine(s.spent, researchBudget(s.runBudget)) // workers stop at the research share; analysis keeps the rest
		if (run) return `run ${run}`
		const t = s.topics.get(topicId)
		const topic = exhaustedLine(t?.spent as Budget | undefined, t?.budget as Budget | undefined)
		return topic ? `topic ${topic}` : null
	}
	return {
		isSatisfiedBy: (t: ExecutableTransition) => (t.nextStateId === "inference" || t.nextStateId === "inference_streaming" || t.nextStateId === "function_call") && why() !== null,
		handle: async () => ({ nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text: `${STOP_MESSAGE} (${why()})` }) } }),
	}
}
