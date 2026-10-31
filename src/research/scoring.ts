// Deterministic quality rules: source reliability, data age, confidence caps, unit normalisation, conflicts.
// The LLM proposes a source type and a raw confidence; code decides the numbers that are stored.
import type { Obj } from "../shared/runtime.ts"
import type { FindingType, SourceType } from "./types.ts"

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))
const round2 = (n: number): number => Math.round(n * 100) / 100

// ---- Source classification and reliability ---------------------------------------------------------------

const hostOf = (url: string): string => {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "")
	} catch {
		return ""
	}
}

const DOMAIN_RULES: [RegExp, SourceType][] = [
	[/(^|\.)(gov|mil|europa\.eu|gov\.[a-z]{2}|gob\.[a-z]{2}|gouv\.[a-z]{2}|admin\.ch|parlament\.[a-z]+)$/, "regulator"],
	[/(^|\.)(sec\.gov|edgar|companieshouse\.gov\.uk|sedar|handelsregister|apr\.gov\.rs|e-justice\.europa\.eu|opencorporates\.com)/, "filing"],
	[/(^|\.)(reuters|bloomberg|ft|wsj|bbc|cnbc|economist|forbes|theguardian|nytimes|techcrunch|euronews|politico|n1info|b92|rts|apnews|theverge|wired|arstechnica|venturebeat|zdnet|pocketgamer|gamesindustry|gamedeveloper|mobilegamer)\.[a-z.]+$/, "news"],
	[/(^|\.)(gartner|forrester|idc|statista|mckinsey|bcg|deloitte|pwc|kpmg|ey|oecd|worldbank|imf|eurostat|sensortower|data\.ai|appmagic|newzoo|grandviewresearch|marketsandmarkets|mordorintelligence|fortunebusinessinsights|cbinsights|crunchbase|similarweb|ibisworld|euromonitor|pitchbook|nielsen|ipsos|gsma|ericsson|cisco)\.[a-z.]+$/, "analyst_report"],
	// Universities and research institutes publish peer-reviewed or official statistics: rated as analyst reports.
	[/(^|\.)(edu|ac\.[a-z]{2}|edu\.[a-z]{2}|uni-[a-z]+\.[a-z]+|arxiv\.org|ssrn\.com|nber\.org|researchgate\.net)$/, "analyst_report"],
	// App stores, standards bodies and official developer documentation are first-hand data about the thing itself.
	[/(^|\.)(play\.google\.com|apps\.apple\.com|developer\.apple\.com|developer\.android\.com|support\.google\.com|docs\.microsoft\.com|learn\.microsoft\.com|w3\.org|ietf\.org|iso\.org|github\.com)$/, "primary"],
	[/(^|\.)(medium\.com|substack\.com|wordpress\.com|blogspot\.[a-z.]+|hashnode\.[a-z.]+|dev\.to|tumblr\.com|ghost\.io)$/, "blog"],
	[/(^|\.)(reddit\.com|quora\.com|stackexchange\.com|stackoverflow\.com|news\.ycombinator\.com|twitter\.com|x\.com|facebook\.com|trustpilot\.com)$/, "forum"],
]

/** Classify from the domain alone; returns undefined when the domain tells us nothing. */
export function classifyDomain(url: string): SourceType | undefined {
	const host = hostOf(url)
	if (!host) return undefined
	for (const [re, type] of DOMAIN_RULES) if (re.test(host)) return type
	return undefined
}

const BASE_RELIABILITY: Record<SourceType, number> = {
	regulator: 0.92,
	filing: 0.9,
	primary: 0.85,
	analyst_report: 0.75,
	news: 0.65,
	vendor: 0.55,
	blog: 0.4,
	forum: 0.3,
	other: 0.5,
}

const SEO_PATH = /\/(best|top-?\d+|vs|versus|alternatives?|review|reviews|compare|comparison|ultimate-guide)\b/i

/**
 * Domain evidence beats the model's guess when it points at a stronger or clearly weaker class (a .gov page is a
 * regulator whatever the model says; a Reddit thread is never "primary").
 */
export function resolveSourceType(url: string, suggested?: SourceType): SourceType {
	const byDomain = classifyDomain(url)
	if (byDomain === "regulator" || byDomain === "filing" || byDomain === "forum" || byDomain === "blog") return byDomain
	return suggested ?? byDomain ?? "other"
}

export interface ReliabilityInput {
	url: string
	type: SourceType
	publishedAt?: string
	injectionFlagged?: boolean
	/** True when the source only repeats another one (origin_id set): it adds no independent weight. */
	secondhand?: boolean
	now: Date
}

export function scoreReliability(i: ReliabilityInput): number {
	let r = BASE_RELIABILITY[i.type]
	if (SEO_PATH.test(i.url) && (i.type === "blog" || i.type === "vendor" || i.type === "other")) r -= 0.1
	if (i.secondhand) r -= 0.1
	if (i.injectionFlagged) r -= 0.2
	const age = ageYears(i.publishedAt, i.now)
	if (age !== undefined && age > 3) r -= 0.1
	return round2(clamp01(r))
}

/** Canonical form for dedupe: lowercase host, no fragment/tracking params/trailing slash. */
export function canonicalUrl(url: string): string {
	try {
		const u = new URL(url)
		u.hash = ""
		u.hostname = u.hostname.toLowerCase()
		for (const key of [...u.searchParams.keys()]) {
			if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$)/i.test(key)) u.searchParams.delete(key)
		}
		u.searchParams.sort()
		if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1)
		return u.toString()
	} catch {
		return url.trim()
	}
}

export const registrableHost = hostOf

/** Distinct origins among sources: many articles citing one report count once. */
export function independentOrigins(ids: string[], sources: Map<string, Obj>): Set<string> {
	const out = new Set<string>()
	for (const id of ids) {
		const s = sources.get(id)
		out.add(typeof s?.origin_id === "string" ? s.origin_id : id)
	}
	return out
}

// ---- Freshness --------------------------------------------------------------------------------------------

/** After this many years a datum of the category is stale. Fast-moving categories age faster. */
const STALE_AFTER_YEARS: Record<string, number> = {
	pricing: 1,
	macro: 1,
	funding: 1.5,
	competitors: 1.5,
	technology: 1.5,
	channels: 2,
	talent: 2,
	market: 2,
	customers: 2,
	regulation: 3,
	ip: 3,
	esg: 3,
}

export function ageYears(date: string | undefined, now: Date): number | undefined {
	if (!date) return undefined
	const t = Date.parse(date)
	if (Number.isNaN(t)) return undefined
	return Math.max(0, (now.getTime() - t) / (365.25 * 24 * 3600 * 1000))
}

export function assessFreshness(asOf: string, now: Date, category?: string): { stale: boolean; factor: number; ageYears: number } {
	const age = ageYears(asOf, now) ?? 0
	const limit = STALE_AFTER_YEARS[category ?? ""] ?? 2
	if (age <= limit / 2) return { stale: false, factor: 1, ageYears: age }
	if (age <= limit) return { stale: false, factor: round2(1 - 0.3 * ((age - limit / 2) / (limit / 2))), ageYears: age }
	return { stale: true, factor: round2(Math.max(0.4, 0.7 - 0.1 * (age - limit))), ageYears: age }
}

// ---- Confidence -------------------------------------------------------------------------------------------

const TYPE_CEILING: Record<FindingType, number> = { fact: 0.95, estimate: 0.7, opinion: 0.5 }

export interface ConfidenceInput {
	modelConfidence: number
	type: FindingType
	sourceReliabilities: number[]
	independentOrigins: number
	freshnessFactor: number
	anyInjectionFlagged: boolean
	verified: boolean
}

/**
 * The model's confidence is an upper bound, never a floor: it is capped by the type, the best source, and
 * penalised for age, a single origin and flagged sources. Independent verification lifts it modestly.
 */
export function finalConfidence(i: ConfidenceInput): number {
	const best = i.sourceReliabilities.length ? Math.max(...i.sourceReliabilities) : 0
	let c = Math.min(clamp01(i.modelConfidence), TYPE_CEILING[i.type], best + 0.1)
	c *= i.freshnessFactor
	if (i.independentOrigins < 2) c *= 0.9
	if (i.anyInjectionFlagged) c *= 0.7
	if (i.verified) c = Math.min(0.97, c + 0.1)
	return round2(clamp01(c))
}

/**
 * Topic-level confidence for EV.TopicProgress. Mean finding confidence, weighted toward verified ones, scaled by
 * coverage (a topic with one finding is not "confident" however good that finding is).
 */
export function topicConfidence(findings: Obj[], targetFindings: number): number {
	if (findings.length === 0) return 0
	let weight = 0
	let sum = 0
	for (const f of findings) {
		const w = f.verified === true ? 1.5 : 1
		sum += (typeof f.confidence === "number" ? f.confidence : 0) * w
		weight += w
	}
	const coverage = Math.min(1, findings.length / Math.max(1, targetFindings))
	return round2(clamp01((sum / weight) * (0.5 + 0.5 * coverage)))
}

// ---- Units ------------------------------------------------------------------------------------------------

const UNIT_ALIASES: Record<string, string> = {
	percent: "%",
	percentage: "%",
	pct: "%",
	eur: "EUR",
	euro: "EUR",
	euros: "EUR",
	"€": "EUR",
	usd: "USD",
	dollar: "USD",
	dollars: "USD",
	"$": "USD",
	gbp: "GBP",
	"£": "GBP",
	rsd: "RSD",
	chf: "CHF",
}

const SCALES: Record<string, number> = { unit: 1, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }
export const SCALE_NAMES = Object.keys(SCALES)

export function normalizeUnit(unit: string): string {
	const trimmed = unit.trim()
	const [head, ...rest] = trimmed.split("/")
	const mapped = UNIT_ALIASES[(head ?? "").trim().toLowerCase()] ?? (head ?? "").trim()
	return [mapped, ...rest.map((r) => r.trim())].join("/")
}

export function currencyOf(unit: string): string | undefined {
	const head = unit.split("/")[0] ?? ""
	return /^[A-Z]{3}$/.test(head) ? head : undefined
}

export interface NormalizedValue {
	value: number
	unit: string
	/** Present when the value was converted to the profile currency. */
	tags: string[]
}

/**
 * Apply the printed scale ("1.2 million") in code, and convert money to the profile currency using a supplied
 * rate table (rates[from] = units of `profileCurrency` per 1 unit of `from`). No rate -> keep the original
 * currency and say so; we never invent an exchange rate.
 */
export function normalizeValue(
	raw: { value: number; unit: string; scale?: string },
	opts: { profileCurrency?: string; fxRates?: Record<string, number> },
): NormalizedValue {
	const tags: string[] = []
	let value = raw.value * (SCALES[raw.scale ?? "unit"] ?? 1)
	let unit = normalizeUnit(raw.unit)
	const cur = currencyOf(unit)
	if (cur && opts.profileCurrency && cur !== opts.profileCurrency) {
		const rate = opts.fxRates?.[cur]
		if (rate && rate > 0) {
			tags.push(`fx:${cur}->${opts.profileCurrency}@${rate}`, `orig:${raw.value}${raw.scale && raw.scale !== "unit" ? ` ${raw.scale}` : ""} ${unit}`)
			value *= rate
			unit = [opts.profileCurrency, ...unit.split("/").slice(1)].join("/")
		} else {
			tags.push("fx_unconverted")
		}
	}
	return { value: Math.round(value * 1e6) / 1e6, unit, tags }
}

// ---- Conflicts --------------------------------------------------------------------------------------------

export const metricTag = (key: string): string => `metric:${key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`

/** Two numeric findings on the same metric and unit that differ by more than `tolerance` (relative) disagree. */
export function findConflicts(candidate: Obj, existing: Iterable<Obj>, tolerance = 0.2): string[] {
	const tag = (candidate.tags as string[] | undefined)?.find((t) => t.startsWith("metric:"))
	if (!tag || typeof candidate.value !== "number") return []
	const out: string[] = []
	for (const f of existing) {
		if (f.id === candidate.id || f.topic_id !== candidate.topic_id) continue
		if (typeof f.value !== "number" || f.unit !== candidate.unit) continue
		if (!(f.tags as string[] | undefined)?.includes(tag)) continue
		const scale = Math.max(Math.abs(f.value), Math.abs(candidate.value as number))
		if (scale === 0) continue
		if (Math.abs(f.value - (candidate.value as number)) / scale > tolerance) out.push(f.id)
	}
	return out
}
