// Code-only participants for the analysis stage:
//  - Recomputer: reacts to a dashboard assumption edit and rebuilds scenarios + plan with the engine (no LLM).
//  - Conductor: on analysis.requested runs the financial -> build-vs-buy -> synthesizer agents in sequence,
//    with a per-stage timeout, and falls back to a deterministic plan if the synthesizer never produced one.
import { SemanticEvent, SituationSpecification, createHuman, type Agent, type Participant, type SituationContext } from "@mozaik-ai/core"
import { EV, type AssumptionOverriddenPayload } from "../shared/events.ts"
import { join, leave, runLoop, sendEvent } from "../shared/runtime.ts"
import { makeAnalysisAgent, modelFor, STAGES, stagePrompt, type Stage } from "./agents.ts"
import { assertValid } from "./contracts.ts"
import type { AnalysisSession } from "./session.ts"

class WhenEvent extends SituationSpecification {
	constructor(private readonly type: string) {
		super()
	}
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === this.type
	}
}

export interface AnalysisOptions {
	/** Give up on a stage that has not answered after this long (default 5 minutes). */
	stageTimeoutMs?: number
	models?: Partial<Record<Stage, string>>
	log?: (msg: string) => void
}

export interface AnalysisParticipants {
	recomputer: Participant
	conductor: Participant
}

export function registerAnalysis(session: AnalysisSession, opts: AnalysisOptions = {}): AnalysisParticipants {
	const log = opts.log ?? ((m: string) => console.error(`[analysis] ${m}`))
	const timeoutMs = opts.stageTimeoutMs ?? 5 * 60_000
	const { state } = session

	let current: { stage: Stage; agent: Agent; timer: NodeJS.Timeout } | null = null
	let running = false

	function finish(): void {
		running = false
		if (!state.plan) {
			try {
				session.recompute()
			} catch (e) {
				log(`could not assemble a fallback plan: ${(e as Error).message}`)
			}
		}
	}

	// Mozaik's loop looks its agent up again after publishing each event (to record it in memory), so an agent must stay
	// joined until its loop has fully returned. Normal path: leave on the next tick. Timeout path: the loop is still
	// running somewhere, so park the agent and remove it only if/when it finally answers.
	const parked = new Map<string, Agent>()
	const leaveLater = (agent: Agent) => setImmediate(() => leave(agent))

	function advance(reason: string): void {
		if (!current) return
		const { stage, agent, timer } = current
		clearTimeout(timer)
		current = null
		if (reason === "answered") leaveLater(agent)
		else {
			parked.set(agent.getId(), agent)
			log(`${stage} abandoned (${reason}); agent kept joined until its loop returns`)
		}
		log(`${stage} done (${reason})`)
		const next = STAGES[STAGES.indexOf(stage) + 1]
		if (next) start(next)
		else finish()
	}

	function start(stage: Stage): void {
		const agent = makeAnalysisAgent(stage, session)
		join(agent)
		const timer = setTimeout(() => advance("timeout"), timeoutMs)
		timer.unref()
		current = { stage, agent, timer }
		runLoop(agent.getId(), stagePrompt(stage, session), {
			model: modelFor(stage, opts.models),
			context: agent.getMemory().getContext(),
			tools: agent.getTools(),
		})
	}

	const conductor = createHuman({
		name: "AnalysisConductor",
		capabilities: [],
		handlers: [
			{
				specification: new WhenEvent(EV.AnalysisRequested),
				processor: {
					apply() {
						if (running) return
						running = true
						delete state.plan // a fresh run must not be mistaken for a finished one by the fallback check
						start(STAGES[0] as Stage)
					},
				},
			},
			{
				specification: new WhenEvent("model.answer"),
				processor: {
					apply({ event }) {
						const late = parked.get(event.producerId)
						if (late) {
							parked.delete(event.producerId)
							leaveLater(late)
						} else if (current && event.producerId === current.agent.getId()) advance("answered")
					},
				},
			},
		],
	})

	const recomputer = createHuman({
		name: "AnalysisRecomputer",
		capabilities: [],
		handlers: [
			{
				specification: new WhenEvent(EV.AssumptionOverridden),
				processor: {
					apply({ event }) {
						const { assumptionId, value } = event.payload as AssumptionOverriddenPayload
						const a = state.assumptions.get(assumptionId)
						if (!a) return log(`override ignored: unknown assumption ${assumptionId}`)
						if (value !== null && !Number.isFinite(value)) return log(`override ignored: ${assumptionId} value is not a number`)
						try {
							const next = { ...a, user_override: value }
							assertValid("assumption", next)
							state.assumptions.set(assumptionId, next)
							session.recompute()
						} catch (e) {
							log(`recompute failed after override of ${assumptionId}: ${(e as Error).message}`)
						}
					},
				},
			},
		],
	})

	join(conductor)
	join(recomputer)
	session.emit = (type, payload) => sendEvent(SemanticEvent.create(type, conductor.getId(), payload), conductor.getId())
	return { recomputer, conductor }
}
