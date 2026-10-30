// Outbound query redaction (MASTERPLAN §5, hard rule for every role): company-confidential details from the
// CompanyProfile must never reach an external search/fetch provider verbatim. We strip them (and refuse a query
// that collapses to nothing) rather than send a half-leaked string.
import type { Obj } from "../../shared/runtime.ts"

export interface RedactionResult {
	text: string
	/** What kinds of things were removed. Never the removed values themselves. */
	redactions: string[]
	/** Set when the query is unusable after redaction. */
	rejected?: string
}

const LEGAL_SUFFIX = /[\s,]+(d\.?o\.?o\.?|d\.?d\.?|a\.?d\.?|inc\.?|llc|ltd\.?|limited|gmbh|ag|s\.?a\.?|s\.?r\.?l\.?|s\.?r\.?o\.?|b\.?v\.?|plc|corp\.?|co\.?|oy|ab|as)$/i
const PUBLIC_STAGES = new Set(["launched", "growth", "mature", "declining"])
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, mio: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }

const norm = (s: string): string =>
	s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
const alnum = (s: string): string => norm(s).replace(/ /g, "")
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function ngrams(text: string, n: number): Set<string> {
	const words = norm(text).split(" ").filter(Boolean)
	const out = new Set<string>()
	for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "))
	return out
}

/** Segments the user marked private inside free text: [private]...[/private] or lines starting private:/confidential:. */
export function privateSegments(notes: string): string[] {
	const segs: string[] = []
	for (const m of notes.matchAll(/\[(?:private|confidential)\]([\s\S]*?)\[\/(?:private|confidential)\]/gi)) segs.push(m[1] ?? "")
	for (const m of notes.matchAll(/^\s*(?:private|confidential)\s*:\s*(.+)$/gim)) segs.push(m[1] ?? "")
	return segs.map((s) => s.trim()).filter(Boolean)
}

function numericFigures(profile: Obj): number[] {
	const out: number[] = []
	const fin = profile.financials as Record<string, unknown> | undefined
	for (const v of Object.values(fin ?? {})) if (typeof v === "number" && Math.abs(v) >= 1000) out.push(Math.abs(v))
	for (const p of (profile.products as Record<string, unknown>[] | undefined) ?? []) {
		for (const k of ["annual_revenue", "annual_cost"]) {
			const v = p[k]
			if (typeof v === "number" && v >= 1000) out.push(v)
		}
	}
	return [...new Set(out)]
}

export class Redactor {
	private readonly always: string[] = []
	private readonly brandOnly: string[] = []
	private readonly figures: number[]
	private readonly noteGrams: Set<string>
	private readonly privateGrams: Set<string>
	private readonly hasProfile: boolean

	constructor(profile: Obj | undefined, extraTerms: string[] = []) {
		this.hasProfile = !!profile
		const p = profile ?? ({ id: "" } as Obj)
		const name = typeof p.name === "string" ? p.name.trim() : ""
		if (name) {
			// The company's own name is allowed only on brand/reputation topics, where it is the search subject.
			this.brandOnly.push(name)
			const bare = name.replace(LEGAL_SUFFIX, "").trim()
			if (bare && bare !== name) this.brandOnly.push(bare)
		}
		for (const prod of (p.products as { name?: string; stage?: string }[] | undefined) ?? []) {
			if (!prod.name?.trim()) continue
			if (prod.stage && PUBLIC_STAGES.has(prod.stage)) this.brandOnly.push(prod.name.trim())
			else this.always.push(prod.name.trim())
		}
		this.always.push(...extraTerms.map((t) => t.trim()).filter(Boolean))
		this.figures = numericFigures(p)
		const notes = typeof p.notes === "string" ? p.notes : ""
		const free = [notes, ...((p.goals as string[] | undefined) ?? []), ...((p.constraints as string[] | undefined) ?? [])].join("\n")
		this.noteGrams = ngrams(free, 4)
		this.privateGrams = new Set(privateSegments(notes).flatMap((s) => [...ngrams(s, 2)]))
		for (const seg of privateSegments(notes)) if (norm(seg).split(" ").length <= 3) this.always.push(seg)
	}

	private terms(category?: string): string[] {
		const base = [...this.always]
		if (category !== "brand") base.push(...this.brandOnly)
		return base.sort((a, b) => b.length - a.length)
	}

	redactQuery(query: string, opts: { category?: string } = {}): RedactionResult {
		const redactions = new Set<string>()
		let text = query

		const strip = (re: RegExp, kind: string) => {
			const next = text.replace(re, " ")
			if (next !== text) redactions.add(kind)
			text = next
		}
		strip(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "email")
		strip(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "iban")
		for (const term of this.terms(opts.category)) {
			strip(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "giu"), "confidential_term")
		}

		if (this.figures.length) {
			text = text.replace(/(\d{1,3}(?:[ .,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(k|thousand|mn|mio|million|m|bn|billion|b)?(?![\p{L}\p{N}])/giu, (m, num: string, unit?: string) => {
				const value = parseNumber(num) * (unit ? (SCALE[unit.toLowerCase()] ?? 1) : 1)
				if (value >= 1000 && this.figures.some((f) => Math.abs(f - value) <= f * 0.005)) {
					redactions.add("internal_figure")
					return " "
				}
				return m
			})
		}

		text = text.replace(/(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g, (m) => {
			const digits = m.replace(/\D/g, "").length
			// Phone numbers have 9-15 digits; lists of years ("2024 2025 2026") and ranges ("2020-2030") are not phones.
			if (digits < 9 || digits > 15 || /^(?:\s*(?:19|20)\d\d[\s,.-]*)+$/.test(m)) return m
			redactions.add("phone")
			return " "
		})

		text = this.stripOverlap(text, this.noteGrams, 4, "profile_notes", redactions)
		text = this.stripOverlap(text, this.privateGrams, 2, "private_notes", redactions)

		text = text.replace(/\s+/g, " ").replace(/(^|\s)["'()[\],;:]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim()
		const remaining = norm(text).split(" ").filter(Boolean)
		if (redactions.size > 0 && remaining.length < 2) {
			return { text: "", redactions: [...redactions], rejected: "Query reduced to nothing after removing confidential company details. Rephrase it generically (industry, region, public competitors)." }
		}
		return { text, redactions: [...redactions] }
	}

	/** Remove word windows that copy `n` consecutive words from the user's private/free text. */
	private stripOverlap(text: string, grams: Set<string>, n: number, kind: string, redactions: Set<string>): string {
		if (grams.size === 0) return text
		const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ raw: m[0], norm: norm(m[0]) }))
		const drop = new Array<boolean>(tokens.length).fill(false)
		for (let i = 0; i + n <= tokens.length; i++) {
			const window = tokens.slice(i, i + n)
			if (window.some((t) => !t.norm)) continue
			if (grams.has(window.map((t) => t.norm).join(" "))) for (let j = i; j < i + n; j++) drop[j] = true
		}
		if (!drop.some(Boolean)) return text
		redactions.add(kind)
		return tokens.filter((_, i) => !drop[i]).map((t) => t.raw).join(" ")
	}

	/** A URL the model constructs must not smuggle confidential terms either (e.g. a search-page URL with the company name). */
	checkUrl(url: string): { ok: true } | { ok: false; reason: string } {
		let decoded = url
		try {
			decoded = decodeURIComponent(url)
		} catch {
			// keep the raw string
		}
		const hay = alnum(decoded)
		for (const term of this.terms()) {
			const t = alnum(term)
			if (t.length >= 4 && hay.includes(t)) return { ok: false, reason: "URL contains a confidential company term" }
		}
		return { ok: true }
	}

	get active(): boolean {
		return this.hasProfile
	}
}

function parseNumber(raw: string): number {
	const s = raw.replace(/\s/g, "")
	// "1.800.000" / "1,800,000" thousands separators vs "1.8" decimals.
	if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""))
	return Number(s.replace(",", "."))
}

export interface RedactorLike {
	redactQuery(query: string, opts?: { category?: string }): RedactionResult
	checkUrl(url: string): { ok: true } | { ok: false; reason: string }
}

/** Rebuilds the Redactor whenever RunState.profile is replaced, so a profile set after start-up is still honoured. */
export class LiveRedactor implements RedactorLike {
	private cached?: { profile: Obj | undefined; redactor: Redactor }

	constructor(
		private readonly getProfile: () => Obj | undefined,
		private readonly extraTerms: string[] = [],
	) {}

	private current(): Redactor {
		const profile = this.getProfile()
		if (!this.cached || this.cached.profile !== profile) this.cached = { profile, redactor: new Redactor(profile, this.extraTerms) }
		return this.cached.redactor
	}

	redactQuery(query: string, opts: { category?: string } = {}): RedactionResult {
		return this.current().redactQuery(query, opts)
	}

	checkUrl(url: string): { ok: true } | { ok: false; reason: string } {
		return this.current().checkUrl(url)
	}
}
