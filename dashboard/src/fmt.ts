export const nf = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 })

/** 1,234,000 -> "1.23M", 48,000 -> "48k". Always signed-aware. */
export function compact(n: number): string {
	const a = Math.abs(n)
	const s = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k` : `${Math.round(a)}`
	return n < 0 ? `−${s}` : s
}
export const money = (n: number, cur = "EUR") => `${compact(n)} ${cur}`
export const pct = (r: number, digits = 0) => `${(r * 100).toFixed(digits)}%`
export const dateOnly = (iso: string) => iso.slice(0, 10)
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
export function confWord(c: number): string {
	return c >= 0.7 ? "high" : c >= 0.45 ? "moderate" : "low"
}
export const label = (s: string) => s.replace(/_/g, " ")
