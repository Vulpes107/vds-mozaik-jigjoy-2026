// Meter: turns every inference.completed into spend.recorded (tokens + USD) so budgets are
// enforced on real usage. Pairs with inference.started by loopId to know the model.
import { SemanticEvent, SituationSpecification, createHuman, type SituationContext } from "@mozaik-ai/core"
import { EV, type SpendRecordedPayload } from "../shared/events.ts"
import { sendEvent } from "../shared/runtime.ts"

// shortcut: USD per million input/output tokens, hard-coded for the gateway's two models; move to config/models.json when prices or models change.
const PRICES: Record<string, { in: number; out: number }> = {
	"claude-sonnet-4-6": { in: 3, out: 15 },
	"claude-haiku-4-5": { in: 1, out: 5 },
}

/** Cached prompt tokens are billed as input here (conservative: cache reads are cheaper, writes dearer, the gateway's rate is unknown). */
export function usdFor(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
	const p = PRICES[model] ?? { in: 3, out: 15 } // unknown model: assume Sonnet pricing rather than free
	return ((inputTokens + cachedTokens) * p.in + outputTokens * p.out) / 1e6
}

class WhenInference extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === "inference.started" || event.type === "inference.completed"
	}
}

export function makeMeter() {
	const modelByLoop = new Map<string, string>()
	return createHuman({
		name: "Meter",
		capabilities: ["metering"],
		handlers: [
			{
				specification: new WhenInference(),
				processor: {
					apply: ({ event, participant }) => {
						// Anthropic reports cached prompt tokens separately; Mozaik keeps them out of inputTokens, so add them back.
						const p = event.payload as { loopId?: string; model?: string; tokenUsage?: { inputTokens: number; outputTokens: number; inputTokenDetails?: { cached_tokens?: number } } }
						if (event.type === "inference.started") {
							if (p.loopId && p.model) modelByLoop.set(p.loopId, p.model)
							return
						}
						const model = modelByLoop.get(p.loopId ?? "") ?? "unknown"
						const cached = p.tokenUsage?.inputTokenDetails?.cached_tokens ?? 0
						const tokens = (p.tokenUsage?.inputTokens ?? 0) + (p.tokenUsage?.outputTokens ?? 0) + cached
						if (!tokens) return
						const payload: SpendRecordedPayload = { agentId: event.producerId, model, tokens, usd: usdFor(model, p.tokenUsage!.inputTokens, p.tokenUsage!.outputTokens, cached) }
						sendEvent(SemanticEvent.create(EV.SpendRecorded, participant.getId(), payload), participant.getId())
					},
				},
			},
		],
	})
}
