// Everything that writes B's contract objects. Tools are thin: they parse arguments and call these methods, which
// enforce the quality rules (sources exist, estimates explain themselves, numbers are normalised in code, ages and
// reliabilities cap confidence, conflicts are linked) and validate against /contracts before touching RunState.
import { EV, type TopicProgressPayload } from "../shared/events.ts"
import type { Obj, RunState } from "../shared/runtime.ts"
import type { Emitter } from "./emitter.ts"
import type { IdGenerator } from "./ids.ts"
import {
	assessFreshness,
	findConflicts,
	finalConfidence,
	independentOrigins,
	metricTag,
	normalizeValue,
	registrableHost,
	topicConfidence,
} from "./scoring.ts"
import type { SourceLibrary } from "./sources.ts"
import type { TaskScope } from "./task.ts"
import { type Clock, type ConflictPayload, type FindingType, isoDate } from "./types.ts"
import { validateContract } from "./validate.ts"

export interface FindingInput {
	claim: string
	type: FindingType
	value?: number | null
	unit?: string | null
	/** Scale printed with the number ("million"); applied here in code. */
	scale?: string
	as_of: string
	source_ids: string[]
	/** The model's own confidence: an upper bound, adjusted by code. */
	confidence: number
	region?: string
	/** Stable key for "the same measurement" (e.g. "competitor_a_entry_price"); enables conflict detection. */
	metric_key?: string
	/** Required for estimates: how the number was derived. */
	estimate_basis?: string
	conflicts_with?: string[]
	tags?: string[]
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; errors: string[] }

export interface StoreDeps {
	state: RunState
	ids: IdGenerator
	library: SourceLibrary
	emitter: Emitter
	clock: Clock
	/** Rates to the profile currency (units of profile currency per 1 foreign unit). Never guessed. */
	fxRates?: Record<string, number>
}

const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()

export class ResearchStore {
	/** Collector's shortlist per topic, read by the Analyst. */
	private readonly material = new Map<string, { sourceId: string; note: string }[]>()

	constructor(private readonly d: StoreDeps) {}

	get state(): RunState {
		return this.d.state
	}

	topic(topicId: string): Obj | undefined {
		return this.d.state.topics.get(topicId)
	}

	findingsFor(topicId: string): Obj[] {
		return [...this.d.state.findings.values()].filter((f) => f.topic_id === topicId)
	}

	// ---- material (Collector -> Analyst hand-over) ----------------------------------------------------------

	saveMaterial(scope: TaskScope, sourceId: string, note: string): Outcome<{ sourceId: string }> {
		const cand = this.d.library.get(sourceId)
		if (!cand) return { ok: false, errors: [`Unknown source id ${sourceId}. Use ids returned by web_search / web_fetch.`] }
		if (!cand.contentRef && cand.tool !== "research") {
			return { ok: false, errors: [`Source ${sourceId} was never fetched, so there is nothing to hand over. Call web_fetch on it first.`] }
		}
		const list = this.material.get(scope.topicId) ?? []
		if (!list.some((m) => m.sourceId === sourceId)) {
			list.push({ sourceId, note: note.slice(0, 300) })
			this.material.set(scope.topicId, list)
			const committed = this.d.library.commit(sourceId, { topicId: scope.topicId, slotId: scope.slotId })
			if (!committed.ok) return committed
			scope.counters.sources++
		}
		return { ok: true, sourceId }
	}

	materialFor(topicId: string): { sourceId: string; note: string }[] {
		return this.material.get(topicId) ?? []
	}

	// ---- findings -------------------------------------------------------------------------------------------

	addFinding(scope: TaskScope, input: FindingInput): Outcome<{ finding: Obj; notes: string[] }> {
		const errors: string[] = []
		const notes: string[] = []
		const now = this.d.clock.now()

		const claim = (input.claim ?? "").trim()
		if (!claim) errors.push("claim is empty")
		if (!Array.isArray(input.source_ids) || input.source_ids.length === 0) {
			errors.push("source_ids is empty: a claim without a source cannot be recorded. If you have no source, say so in your summary instead.")
		}
		const unknown = (input.source_ids ?? []).filter((id) => !this.d.library.has(id))
		if (unknown.length) errors.push(`Unknown source id(s): ${unknown.join(", ")}. Cite only ids returned by web_search / web_fetch.`)
		if (input.type === "estimate" && (input.estimate_basis ?? "").trim().length < 10) {
			errors.push("An estimate must say how it was derived: pass estimate_basis (what inputs, what method).")
		}
		const asOf = (input.as_of ?? "").trim()
		const asOfMs = Date.parse(asOf)
		if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(asOfMs)) errors.push("as_of must be a date YYYY-MM-DD (the date the data refers to, not today's date unless it is current).")
		else if (asOfMs > now.getTime() + 86_400_000) errors.push(`as_of ${asOf} is in the future.`)
		const hasValue = typeof input.value === "number" && Number.isFinite(input.value)
		if (hasValue && !(input.unit ?? "").trim()) errors.push("unit is required when value is given (e.g. EUR, %, users, months).")
		if (!hasValue && input.value !== undefined && input.value !== null) errors.push("value must be a finite number")
		const badConflicts = (input.conflicts_with ?? []).filter((id) => !this.d.state.findings.has(id))
		if (badConflicts.length) errors.push(`conflicts_with references unknown finding(s): ${badConflicts.join(", ")}`)
		if (errors.length) return { ok: false, errors }

		for (const id of input.source_ids) {
			const c = this.d.library.commit(id, { topicId: scope.topicId, slotId: scope.slotId })
			if (!c.ok) return { ok: false, errors: [`source ${id}: ${c.errors.join("; ")}`] }
		}
		const sources = input.source_ids.map((id) => this.d.state.sources.get(id)!)
		const reliabilities = sources.map((s) => Number(s.reliability))

		// "No source -> not a fact", and weak sources cannot carry a fact either.
		let type = input.type
		if (type === "fact" && Math.max(...reliabilities) < 0.4) {
			type = "estimate"
			notes.push("type downgraded fact -> estimate: all cited sources are low-reliability (blogs/forums/aggregators). Find a primary or independent source to restore it.")
		}

		// Numbers are normalised in code (scale, unit aliases, optional FX); the model never does the arithmetic.
		let value: number | null | undefined = hasValue ? input.value : undefined
		let unit: string | null | undefined = input.unit ?? undefined
		const tags = new Set<string>(input.tags ?? [])
		if (hasValue) {
			const profileCurrency = typeof this.d.state.profile?.currency === "string" ? this.d.state.profile.currency : undefined
			const n = normalizeValue({ value: input.value as number, unit: input.unit as string, ...(input.scale ? { scale: input.scale } : {}) }, { ...(profileCurrency ? { profileCurrency } : {}), ...(this.d.fxRates ? { fxRates: this.d.fxRates } : {}) })
			value = n.value
			unit = n.unit
			n.tags.forEach((t) => tags.add(t))
		}
		if (input.metric_key) tags.add(metricTag(input.metric_key))

		const topic = this.topic(scope.topicId)
		const category = typeof topic?.category === "string" ? topic.category : scope.category
		const fresh = assessFreshness(asOf, now, category)
		if (fresh.stale) notes.push(`data is ${fresh.ageYears.toFixed(1)} years old for a '${category ?? "general"}' topic: marked stale, confidence reduced.`)

		const origins = independentOrigins(input.source_ids, this.d.state.sources)
		const flagged = sources.some((s) => s.injection_flagged === true)
		const confidence = finalConfidence({
			modelConfidence: input.confidence,
			type,
			sourceReliabilities: reliabilities,
			independentOrigins: origins.size,
			freshnessFactor: fresh.factor,
			anyInjectionFlagged: flagged,
			verified: false,
		})
		if (confidence < input.confidence - 0.05) notes.push(`confidence adjusted ${input.confidence} -> ${confidence} (source reliability, age, single origin, or flags).`)

		const fullClaim = type === "estimate" && input.estimate_basis ? `${claim} [Estimate basis: ${input.estimate_basis.trim()}]` : claim

		// Re-submitting the same claim from the same sources is a no-op, not a duplicate.
		const dup = this.findingsFor(scope.topicId).find((f) => norm(String(f.claim)) === norm(fullClaim) && f.value === (value ?? undefined))
		if (dup) return { ok: true, finding: dup, notes: [`already recorded as ${dup.id}`] }

		const id = this.d.ids.next("f")
		const finding = compact({
			schema_version: "1.0",
			id,
			run_id: this.d.state.runId,
			project_id: typeof this.d.state.profile?.project_id === "string" ? this.d.state.profile.project_id : undefined,
			topic_id: scope.topicId,
			claim: fullClaim,
			type,
			value: value === undefined ? undefined : value,
			unit: value === undefined ? undefined : unit,
			as_of: asOf,
			region: input.region,
			source_ids: [...input.source_ids],
			confidence,
			verified: false,
			conflicts_with: [] as string[],
			stale: fresh.stale,
			tags: tags.size ? [...tags] : undefined,
			created_by: scope.agentRef,
			created_at: now.toISOString(),
		}) as Obj

		const conflicts = new Set<string>([...(input.conflicts_with ?? [])])
		for (const c of findConflicts(finding, this.d.state.findings.values())) conflicts.add(c)
		finding.conflicts_with = [...conflicts]

		const valid = validateContract("finding", finding)
		if (!valid.ok) return { ok: false, errors: valid.errors }

		this.d.state.findings.set(id, finding)
		scope.counters.findings++
		this.d.emitter.emit(EV.FindingSubmitted, { id, topicId: scope.topicId, slotId: scope.slotId })
		for (const other of conflicts) this.linkConflict(finding, other, scope)
		if (conflicts.size) notes.push(`conflicts with ${[...conflicts].join(", ")}: recorded on both findings; the Synthesizer will list the contradiction.`)
		this.emitProgress(scope, Math.min(1, scope.counters.findings / this.targetFindings(scope)))
		return { ok: true, finding, notes }
	}

	/** Reciprocal conflict link, emitted once per new pair. */
	private linkConflict(finding: Obj, otherId: string, scope: TaskScope): void {
		const other = this.d.state.findings.get(otherId)
		if (!other) return
		const list = new Set<string>((other.conflicts_with as string[] | undefined) ?? [])
		if (!list.has(finding.id)) {
			list.add(finding.id)
			this.d.state.findings.set(otherId, { ...other, conflicts_with: [...list] })
			this.d.emitter.emit(EV.FindingSubmitted, { id: otherId, topicId: String(other.topic_id), updated: true })
		}
		const payload: ConflictPayload = { id: finding.id, conflictsWith: otherId, topicId: scope.topicId }
		this.d.emitter.emit(EV.ConflictDetected, payload)
	}

	// ---- verification ---------------------------------------------------------------------------------------

	listUnverified(topicId: string): Obj[] {
		return this.findingsFor(topicId).filter((f) => f.verified !== true && f.type !== "opinion")
	}

	verify(
		scope: TaskScope,
		input: { finding_id: string; outcome: "confirmed" | "contradicted" | "unconfirmed" | "outdated"; evidence_source_ids?: string[]; note: string; conflicting_finding_id?: string },
	): Outcome<{ finding: Obj; notes: string[] }> {
		const finding = this.d.state.findings.get(input.finding_id)
		if (!finding) return { ok: false, errors: [`Unknown finding ${input.finding_id}`] }
		const evidence = input.evidence_source_ids ?? []
		const unknown = evidence.filter((id) => !this.d.library.has(id))
		if (unknown.length) return { ok: false, errors: [`Unknown source id(s): ${unknown.join(", ")}`] }
		const notes: string[] = []
		let next: Obj = { ...finding }
		const now = this.d.clock.now()

		if (input.outcome !== "unconfirmed" && evidence.length === 0) {
			return { ok: false, errors: [`outcome '${input.outcome}' needs evidence_source_ids (at least one source you actually fetched).`] }
		}
		for (const id of evidence) {
			const c = this.d.library.commit(id, { topicId: scope.topicId, slotId: scope.slotId })
			if (!c.ok) return { ok: false, errors: [`source ${id}: ${c.errors.join("; ")}`] }
		}

		const original = (finding.source_ids as string[]).map((id) => this.d.state.sources.get(id)).filter((s): s is Obj => !!s)
		const originalHosts = new Set(original.map((s) => registrableHost(String(s.url))))
		const originalOrigins = independentOrigins(finding.source_ids as string[], this.d.state.sources)

		if (input.outcome === "confirmed") {
			const independent = evidence.filter((id) => {
				const s = this.d.state.sources.get(id)
				if (!s || s.injection_flagged === true) return false
				const origin = typeof s.origin_id === "string" ? s.origin_id : id
				return !originalOrigins.has(origin) && !originalHosts.has(registrableHost(String(s.url)))
			})
			if (independent.length === 0) {
				return { ok: false, errors: ["Evidence is not independent: it shares a publisher or an origin with the original sources, or is flagged. Find a source from a different publisher that does not just cite the same report."] }
			}
			const sourceIds = [...new Set([...(finding.source_ids as string[]), ...independent])]
			const sources = sourceIds.map((id) => this.d.state.sources.get(id)!)
			const fresh = assessFreshness(String(finding.as_of), now, String(this.topic(scope.topicId)?.category ?? ""))
			next = {
				...next,
				source_ids: sourceIds,
				verified: true,
				verified_by: scope.agentRef,
				confidence: finalConfidence({
					modelConfidence: Math.max(Number(finding.confidence), 0.5),
					type: finding.type as FindingType,
					sourceReliabilities: sources.map((s) => Number(s.reliability)),
					independentOrigins: independentOrigins(sourceIds, this.d.state.sources).size,
					freshnessFactor: fresh.factor,
					anyInjectionFlagged: false,
					verified: true,
				}),
			}
		} else if (input.outcome === "contradicted") {
			next = { ...next, verified: false, confidence: Math.round(Number(finding.confidence) * 0.6 * 100) / 100, tags: [...new Set([...((finding.tags as string[] | undefined) ?? []), "contradicted"])] }
			if (input.conflicting_finding_id) {
				if (!this.d.state.findings.has(input.conflicting_finding_id)) return { ok: false, errors: [`Unknown conflicting_finding_id ${input.conflicting_finding_id}. Submit the contradicting claim with submit_finding first.`] }
				next.conflicts_with = [...new Set([...((finding.conflicts_with as string[] | undefined) ?? []), input.conflicting_finding_id])]
			} else notes.push("Record the contradicting claim with submit_finding (conflicts_with=[this id]) so both sides are on the record.")
		} else if (input.outcome === "outdated") {
			next = { ...next, stale: true, verified: false, confidence: Math.round(Number(finding.confidence) * 0.6 * 100) / 100 }
		} else {
			next = { ...next, tags: [...new Set([...((finding.tags as string[] | undefined) ?? []), "no_second_source"])] }
		}

		const valid = validateContract("finding", next)
		if (!valid.ok) return { ok: false, errors: valid.errors }
		this.d.state.findings.set(next.id, next)
		scope.counters.verifications++
		this.d.emitter.emit(EV.FindingSubmitted, { id: next.id, topicId: scope.topicId, slotId: scope.slotId, updated: true })
		if (input.outcome === "contradicted" && input.conflicting_finding_id) this.linkConflict(next, input.conflicting_finding_id, scope)
		const total = Math.max(1, this.listUnverified(scope.topicId).length + scope.counters.verifications)
		this.emitProgress(scope, Math.min(1, scope.counters.verifications / total))
		return { ok: true, finding: next, notes }
	}

	// ---- progress -------------------------------------------------------------------------------------------

	targetFindings(scope: TaskScope): number {
		return scope.depth === "deep" ? 8 : 3
	}

	/** Confidence is computed from the recorded findings, not asked of the model. */
	emitProgress(scope: TaskScope, progress?: number): void {
		const payload: TopicProgressPayload = {
			topicId: scope.topicId,
			slotId: scope.slotId,
			confidence: topicConfidence(this.findingsFor(scope.topicId), this.targetFindings(scope)),
			...(progress === undefined ? {} : { progress: Math.round(progress * 100) / 100 }),
		}
		this.d.emitter.emit(EV.TopicProgress, payload)
	}

	today(): string {
		return isoDate(this.d.clock.now())
	}
}
