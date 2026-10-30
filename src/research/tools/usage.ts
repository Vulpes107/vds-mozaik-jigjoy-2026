// Call budgets (hard limits) and usage metering per agent/topic. Charged per provider attempt, not per cache hit.
import { BudgetStop } from "./resilience.ts"

export interface UsageRecord {
	slotId: string
	topicId: string
	tool: string
	provider: string
	cached: boolean
	ms: number
	ok: boolean
}

export class UsageMeter {
	readonly records: UsageRecord[] = []
	onRecord?: (r: UsageRecord) => void

	record(r: UsageRecord): void {
		this.records.push(r)
		this.onRecord?.(r)
	}

	/** Provider calls actually made (cache hits excluded). */
	callsFor(filter: { slotId?: string; topicId?: string } = {}): number {
		return this.records.filter((r) => !r.cached && (!filter.slotId || r.slotId === filter.slotId) && (!filter.topicId || r.topicId === filter.topicId)).length
	}

	cacheHits(): number {
		return this.records.filter((r) => r.cached).length
	}

	summary(): Record<string, { calls: number; cached: number }> {
		const out: Record<string, { calls: number; cached: number }> = {}
		for (const r of this.records) {
			const e = (out[r.slotId] ??= { calls: 0, cached: 0 })
			if (r.cached) e.cached++
			else e.calls++
		}
		return out
	}
}

export interface CallLimits {
	/** Max provider calls per topic; undefined = unlimited. */
	topicCalls(topicId: string): number | undefined
	/** Max provider calls for the whole run; undefined = unlimited. */
	runCalls(): number | undefined
}

export const noLimits: CallLimits = { topicCalls: () => undefined, runCalls: () => undefined }

export class CallBudget {
	private perTopic = new Map<string, number>()
	private total = 0

	constructor(private readonly limits: CallLimits = noLimits) {}

	/** Reserve one provider call or throw BudgetStop. */
	charge(topicId: string): void {
		const topicLimit = this.limits.topicCalls(topicId)
		const runLimit = this.limits.runCalls()
		if (topicLimit !== undefined && (this.perTopic.get(topicId) ?? 0) >= topicLimit) {
			throw new BudgetStop("topic", `Topic call budget of ${topicLimit} reached`)
		}
		if (runLimit !== undefined && this.total >= runLimit) {
			throw new BudgetStop("run", `Run call budget of ${runLimit} reached`)
		}
		this.perTopic.set(topicId, (this.perTopic.get(topicId) ?? 0) + 1)
		this.total++
	}

	used(topicId: string): number {
		return this.perTopic.get(topicId) ?? 0
	}

	get totalUsed(): number {
		return this.total
	}
}
