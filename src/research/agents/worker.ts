// A worker SLOT is stable; the Agent inside it is disposable (root CLAUDE.md, "Dynamic reassignment"). The slot
// worker is a code-only participant: it reacts to EV.TaskAssigned for its slot, builds a fresh Agent for the task's
// role (clean context + handoff note), runs the loop under hard limits, and on completion sends EV.TaskFinished and
// leaves. A reassignment mid-task stops the old agent at its next loop transition and starts a fresh one.
import { Agent, type Human, ModelMessageItem, SituationSpecification, createHuman, type InterceptionHandler, type SituationContext } from "@mozaik-ai/core"
import { EV, type TaskAssignedPayload, type TopicProgressPayload } from "../../shared/events.ts"
import { join, leave, runLoop, type RunState } from "../../shared/runtime.ts"
import { exhaustedLine } from "../../orchestrator/budget.ts"
import { taskPrompt, type TaskLimits } from "../prompts.ts"
import { TaskScope } from "../task.ts"
import type { TaskFinishedPayload } from "../types.ts"
import { makeAnalyst } from "./analyst.ts"
import { makeCollector } from "./collector.ts"
import type { ResearchDeps, WorkerContext } from "./context.ts"
import { makeScout } from "./scout.ts"
import { makeVerifier } from "./verifier.ts"

export const FACTORIES = { scout: makeScout, collector: makeCollector, analyst: makeAnalyst, verifier: makeVerifier } as const

type StopReason = "tokens" | "tool_calls" | "timeout" | "cancelled" | "run_budget"

export class TaskRun {
	finished = false
	left = false
	superseded = false
	tokens = 0
	toolCalls = 0
	stop?: StopReason
	lastAnswer = ""
	timer?: ReturnType<typeof setTimeout>

	constructor(
		readonly agent: Agent,
		readonly scope: TaskScope,
		readonly limits: TaskLimits,
		/** Run-level budget (A); when any line is exhausted the task ends at its next step, not at its own limit. */
		readonly run?: Pick<RunState, "spent" | "runBudget">,
	) {}

	reason(): StopReason | undefined {
		if (this.stop) return this.stop
		if (this.tokens >= this.limits.maxTokens) return "tokens"
		if (this.run && exhaustedLine(this.run.spent, this.run.runBudget)) return "run_budget"
		return undefined
	}
}

/**
 * Hard limits enforced between loop steps: before every inference or tool call, if the task is over budget, was
 * cancelled, or timed out, the transition is rewritten to a final model message so the loop ends cleanly.
 */
export function budgetGuard(run: TaskRun): InterceptionHandler {
	return {
		isSatisfiedBy: (t) => t.nextStateId === "inference" || t.nextStateId === "inference_streaming" || t.nextStateId === "function_call",
		async handle(t) {
			if (t.nextStateId === "function_call") {
				if (run.toolCalls >= run.limits.maxToolCalls) run.stop ??= "tool_calls"
				else run.toolCalls++
			}
			const reason = run.reason()
			if (!reason) return t
			run.stop ??= reason
			return { nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text: `[stopped: ${reason}]` }) } }
		},
	}
}

const when = (test: (c: SituationContext) => boolean): SituationSpecification =>
	new (class extends SituationSpecification {
		isSatisfiedBy(c: SituationContext): boolean {
			return test(c)
		}
	})()

/** How long a finished task's agent may stay joined if its loop never ends (e.g. a model call that hangs). */
const RETIRE_FALLBACK_MS = 60_000

export function createSlotWorker(slotId: string, deps: ResearchDeps): Human {
	let current: TaskRun | undefined
	/** Every agent whose loop may still publish events, by agent id. */
	const runs = new Map<string, TaskRun>()

	/**
	 * Remove the agent from the runtime, but never while its loop is still publishing: Mozaik's loop visitor looks the
	 * agent up after each event and throws if it already left. So we retire only after the loop's final model.answer
	 * (on the next tick, once that event has been fully delivered) or, as a fallback, long after the task ended.
	 */
	const retire = (run: TaskRun): void => {
		if (run.left) return
		run.left = true
		runs.delete(run.agent.getId())
		try {
			leave(run.agent)
		} catch {
			// already gone
		}
	}

	const finish = (run: TaskRun, outcome: TaskFinishedPayload["outcome"], summary: string): void => {
		if (run.finished) return
		run.finished = true
		if (run.timer) clearTimeout(run.timer)
		setTimeout(() => retire(run), RETIRE_FALLBACK_MS).unref?.()
		if (current === run) current = undefined
		const c = run.scope.counters
		// Provider calls this task made, so the orchestrator's run spend (and the dashboard) see them.
		const calls = c.searches + c.fetches
		if (calls) deps.emitter.emit(EV.TopicProgress, { topicId: run.scope.topicId, slotId, spent: { calls } } satisfies TopicProgressPayload)
		if (run.superseded) return // the Allocator reassigned this slot; it does not expect a TaskFinished for the old task

		const empty =
			(run.scope.role === "scout" && c.scoresReported === 0) ||
			(run.scope.role === "collector" && c.sources === 0) ||
			(run.scope.role === "analyst" && c.findings === 0)
		if (empty && run.scope.gaps.length === 0) {
			run.scope.recordGap(outcome === "done" ? `${run.scope.role} finished without producing output` : `${run.scope.role} stopped (${outcome}) without producing output`)
		}
		const payload: TaskFinishedPayload = {
			slotId,
			role: run.scope.role,
			topicId: run.scope.topicId,
			outcome,
			findings: c.findings,
			sources: c.sources,
			...(summary ? { summary: summary.slice(0, 600) } : {}),
		}
		deps.emitter.emit(EV.TaskFinished, payload)
	}

	const start = (p: TaskAssignedPayload): void => {
		if (current) {
			current.superseded = true
			current.stop = "cancelled"
			finish(current, "done", "")
		}
		const topic = deps.state.topics.get(p.topicId)
		const factory = FACTORIES[p.role as keyof typeof FACTORIES]
		if (!topic || !factory) {
			const payload: TaskFinishedPayload = { slotId, role: p.role, topicId: p.topicId, outcome: "error", summary: !topic ? `unknown topic ${p.topicId}` : `unknown role ${p.role}`, findings: 0, sources: 0 }
			deps.emitter.emit(EV.TaskFinished, payload)
			return
		}
		const depth = topic.state === "deep" ? "deep" : "shallow"
		const scope = new TaskScope(slotId, p.role, p.topicId, deps.emitter, typeof topic.category === "string" ? topic.category : undefined, depth)
		const limits = deps.limitsFor(p.role, depth, topic)
		const ctx: WorkerContext = { deps, scope, topic }
		const agent = factory(ctx)
		const run = new TaskRun(agent, scope, limits)
		current = run
		runs.set(agent.getId(), run)

		join(agent)
		run.timer = setTimeout(() => {
			run.stop ??= "timeout"
			// The loop may be stuck inside a model call; do not wait for it.
			finish(run, "timeout", run.lastAnswer)
		}, limits.seconds * 1000)
		run.timer.unref?.()

		const message = taskPrompt(p.role, topic, deps.state.profile, depth, limits, p.handoff)
		runLoop(
			agent.getId(),
			message,
			{ model: deps.models[p.role], maxOutputTokens: limits.maxOutputTokens, context: agent.getMemory().getContext(), tools: agent.getTools() },
			budgetGuard(run),
		)
	}

	const mine = (c: SituationContext): TaskRun | undefined => runs.get(c.event.producerId)

	return createHuman({
		name: `ResearchSlot ${slotId}`,
		capabilities: ["research"],
		handlers: [
			{
				specification: when(({ event }) => event.type === EV.TaskAssigned && (event.payload as TaskAssignedPayload | undefined)?.slotId === slotId),
				processor: {
					apply({ event }) {
						try {
							start(event.payload as TaskAssignedPayload)
						} catch (e) {
							console.error(`[research:${slotId}] failed to start task:`, e)
						}
					},
				},
			},
			{
				specification: when((c) => c.event.type === "inference.completed" && !!mine(c)),
				processor: {
					apply(c) {
						// Anthropic reports cached prompt tokens outside totalTokens; they are billed too.
						const usage = (c.event.payload as { tokenUsage?: { totalTokens?: number; inputTokenDetails?: { cached_tokens?: number } } } | undefined)?.tokenUsage
						const run = mine(c)
						if (run && typeof usage?.totalTokens === "number") run.tokens += usage.totalTokens + (usage.inputTokenDetails?.cached_tokens ?? 0)
					},
				},
			},
			{
				specification: when((c) => c.event.type === "model.answer" && !!mine(c)),
				processor: {
					apply(c) {
						const run = mine(c)
						if (!run) return
						// The loop is over. Retire the agent on the next tick (after this event finished publishing).
						setTimeout(() => retire(run), 0)
						const text = (c.event.payload as { answer?: { content?: { text?: string } } } | undefined)?.answer?.content?.text ?? ""
						run.lastAnswer = text
						const outcome: TaskFinishedPayload["outcome"] = run.stop === "tokens" || run.stop === "tool_calls" ? "budget_exhausted" : run.stop === "timeout" ? "timeout" : "done"
						finish(run, outcome, text)
					},
				},
			},
		],
	})
}
