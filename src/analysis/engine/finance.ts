// Pure financial math. Monthly cash-flow series, annual discount rate.
// flows[m] is the net cash flow in month m (m = 0 is the first month).

export const round = (x: number, dp = 2): number => {
	const f = 10 ** dp
	return Math.round((x + Number.EPSILON) * f) / f
}

/** NPV with monthly flows discounted at (1 + annualRate) ^ (m / 12). Month 0 is undiscounted. */
export function npvMonthly(annualRate: number, flows: readonly number[]): number {
	let total = 0
	for (let m = 0; m < flows.length; m++) total += (flows[m] as number) / (1 + annualRate) ** (m / 12)
	return total
}

/**
 * Annualised IRR of monthly flows, or null when undefined (no sign change, no root in range).
 * Bisection on the monthly rate in (-99%, 100%]. If flows change sign more than once the root found
 * is the one bracketed by the search range, not necessarily unique - callers should treat IRR as indicative.
 */
export function irrAnnual(flows: readonly number[]): number | null {
	if (!flows.some((f) => f < 0) || !flows.some((f) => f > 0)) return null
	const f = (r: number) => {
		let s = 0
		for (let m = 0; m < flows.length; m++) s += (flows[m] as number) / (1 + r) ** m
		return s
	}
	let lo = -0.99
	let hi = 1
	const fLo = f(lo)
	const fHi = f(hi)
	if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2
		const fm = f(mid)
		if (fm === 0) {
			lo = hi = mid
			break
		}
		if (f(lo) * fm < 0) hi = mid
		else lo = mid
	}
	const monthly = (lo + hi) / 2
	return (1 + monthly) ** 12 - 1
}

export function cumulative(flows: readonly number[]): number[] {
	const out: number[] = []
	let s = 0
	for (const f of flows) out.push((s += f))
	return out
}

/**
 * Months until cumulative cash flow is non-negative and stays so through the horizon (1-based month count).
 * Null when there is no investment to pay back or it is not recovered within the horizon.
 */
export function paybackMonths(flows: readonly number[], totalInvestment: number): number | null {
	if (totalInvestment <= 0) return null
	const cum = cumulative(flows)
	let lastNeg = -1
	cum.forEach((c, i) => {
		if (c < 0) lastNeg = i
	})
	if (lastNeg === cum.length - 1) return null
	return lastNeg + 2
}

/** First month (0-based) from which monthly operating cash flow is >= 0 for the rest of the horizon. */
export function breakEvenMonth(operating: readonly number[]): number | null {
	let first: number | null = null
	for (let m = operating.length - 1; m >= 0; m--) {
		if ((operating[m] as number) >= 0) first = m
		else break
	}
	return first
}
