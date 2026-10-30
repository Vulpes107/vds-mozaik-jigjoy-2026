// Retry with backoff and a rate limiter. Both take an injectable sleep so tests run instantly.
import { classifyError, ProviderError } from "./provider.ts"

export type Sleep = (ms: number) => Promise<void>
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export interface RetryPolicy {
	/** Total attempts including the first. */
	attempts: number
	baseMs: number
	maxMs: number
	sleep: Sleep
	/** Called before each attempt; throw to abort (used to charge the call budget). */
	beforeAttempt?: (attempt: number) => void
	random?: () => number
}

export const defaultRetry = (): RetryPolicy => ({ attempts: 3, baseMs: 500, maxMs: 8000, sleep: realSleep })

/** Run `fn`, retrying retryable ProviderErrors with exponential backoff and jitter. Throws the last ProviderError. */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy): Promise<{ value: T; attempts: number }> {
	const random = policy.random ?? Math.random
	let last: ProviderError | undefined
	for (let attempt = 1; attempt <= policy.attempts; attempt++) {
		policy.beforeAttempt?.(attempt)
		try {
			return { value: await fn(), attempts: attempt }
		} catch (err) {
			if (err instanceof BudgetStop) throw err
			last = classifyError(err)
			if (!last.retryable || attempt === policy.attempts) break
			const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1))
			await policy.sleep(Math.max(last.retryAfterMs ?? 0, backoff / 2 + random() * (backoff / 2)))
		}
	}
	throw last ?? new ProviderError("unknown", "no attempt made")
}

/** Thrown by a budget check to stop retrying without counting as a provider failure. */
export class BudgetStop extends Error {
	constructor(readonly scope: "topic" | "run", message: string) {
		super(message)
		this.name = "BudgetStop"
	}
}

/** Caps concurrency and enforces a minimum gap between call starts. */
export class RateLimiter {
	private active = 0
	private lastStart = 0
	private readonly waiters: (() => void)[] = []

	constructor(
		private readonly opts: { maxConcurrent: number; minIntervalMs: number },
		private readonly sleep: Sleep = realSleep,
		private readonly now: () => number = Date.now,
	) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire()
		try {
			return await fn()
		} finally {
			this.active--
			this.waiters.shift()?.()
		}
	}

	private async acquire(): Promise<void> {
		while (this.active >= this.opts.maxConcurrent) {
			await new Promise<void>((resolve) => this.waiters.push(resolve))
		}
		this.active++
		const wait = this.lastStart + this.opts.minIntervalMs - this.now()
		// Reserve our slot in the schedule before sleeping so concurrent callers queue behind us.
		this.lastStart = Math.max(this.now(), this.lastStart + this.opts.minIntervalMs)
		if (wait > 0) await this.sleep(wait)
	}
}
