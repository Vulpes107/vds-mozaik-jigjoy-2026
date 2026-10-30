// The Source library: every URL the agents see gets a stable id, but only sources that are cited by a finding,
// saved as material, or flagged as hostile become contract `Source`s in RunState. This keeps the dashboard's
// source library meaningful and stops the model from citing ids it invented (unknown ids are rejected).
import { createHash } from "node:crypto"
import { EV } from "../shared/events.ts"
import type { Obj, RunState } from "../shared/runtime.ts"
import type { ContentStore } from "./content.ts"
import type { Emitter } from "./emitter.ts"
import type { IdGenerator } from "./ids.ts"
import { canonicalUrl, registrableHost, resolveSourceType, scoreReliability } from "./scoring.ts"
import { scanForInjection, type InjectionScan } from "./safety/injection.ts"
import { type Clock, type InjectionFlaggedPayload, type SourceTool, type SourceType, isoDate } from "./types.ts"
import { validateContract } from "./validate.ts"

export interface Candidate {
	id: string
	url: string
	canonical: string
	title: string
	tool: SourceTool
	publishedAt?: string
	publisher?: string
	suggestedType?: SourceType
	originId?: string
	retrievedAt: string
	contentRef?: string
	contentHash?: string
	injectionPatterns: string[]
	committed: boolean
	flagEmitted: boolean
}

export interface LibraryDeps {
	state: Pick<RunState, "sources" | "findings" | "runId" | "profile">
	ids: IdGenerator
	clock: Clock
	content: ContentStore
	emitter: Emitter
}

export type CommitResult = { ok: true; source: Obj } | { ok: false; errors: string[] }

const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

function toDate(value: string | undefined): string | undefined {
	if (!value) return undefined
	const t = Date.parse(value)
	return Number.isNaN(t) ? undefined : isoDate(new Date(t))
}

export class SourceLibrary {
	private readonly byCanonical = new Map<string, Candidate>()
	private readonly byId = new Map<string, Candidate>()

	constructor(private readonly deps: LibraryDeps) {}

	/** Register (or look up) a URL. Idempotent by canonical URL. Returns undefined for URLs that are not valid. */
	observe(info: { url: string; title?: string; tool: SourceTool; publishedAt?: string; publisher?: string }): Candidate | undefined {
		if (!/^https?:\/\//i.test(info.url)) return undefined
		try {
			new URL(info.url)
		} catch {
			return undefined
		}
		const canonical = canonicalUrl(info.url)
		const existing = this.byCanonical.get(canonical)
		if (existing) {
			if (!existing.title && info.title) existing.title = info.title
			existing.publishedAt ??= toDate(info.publishedAt)
			existing.publisher ??= info.publisher
			// A fetched page outranks a search snippet as the way we know a source.
			if (info.tool !== "search" && existing.tool === "search") existing.tool = info.tool
			return existing
		}
		const candidate: Candidate = {
			id: this.deps.ids.next("s"),
			url: info.url,
			canonical,
			title: info.title ?? "",
			tool: info.tool,
			retrievedAt: this.deps.clock.now().toISOString(),
			injectionPatterns: [],
			committed: false,
			flagEmitted: false,
			...(toDate(info.publishedAt) ? { publishedAt: toDate(info.publishedAt)! } : {}),
			...(info.publisher ? { publisher: info.publisher } : {}),
		}
		this.byCanonical.set(canonical, candidate)
		this.byId.set(candidate.id, candidate)
		return candidate
	}

	get(id: string): Candidate | undefined {
		return this.byId.get(id)
	}

	has(id: string): boolean {
		return this.byId.has(id)
	}

	/** Store raw + cleaned text and record any injection finding. Flagged pages are committed straight away. */
	async attachContent(id: string, raw: string, scan: InjectionScan, ctx: { topicId?: string; slotId?: string } = {}): Promise<void> {
		const c = this.byId.get(id)
		if (!c) throw new Error(`Unknown source ${id}`)
		c.contentRef = await this.deps.content.put(this.deps.state.runId, id, { raw, cleaned: scan.cleaned })
		c.contentHash = createHash("sha256").update(raw).digest("hex")
		this.noteInjection(c, scan, ctx)
	}

	/** Flag from a search snippet or any other scanned text. */
	noteInjection(c: Candidate, scan: InjectionScan, ctx: { topicId?: string; slotId?: string } = {}): void {
		if (!scan.flagged) return
		for (const p of scan.patterns) if (!c.injectionPatterns.includes(p)) c.injectionPatterns.push(p)
		if (!c.flagEmitted) {
			c.flagEmitted = true
			// The hostile page is evidence the dashboard should show, so it is committed even if never cited.
			this.commit(c.id, ctx)
			const payload: InjectionFlaggedPayload = compact({ id: c.id, url: c.url, topicId: ctx.topicId, slotId: ctx.slotId, patterns: [...c.injectionPatterns] })
			this.deps.emitter.emit(EV.InjectionFlagged, payload)
		}
	}

	/** Model-supplied metadata for a source it has seen. The model may suggest a type; code sets reliability. */
	annotate(id: string, meta: { sourceType?: SourceType; publisher?: string; publishedAt?: string; originUrl?: string }): { ok: true } | { ok: false; error: string } {
		const c = this.byId.get(id)
		if (!c) return { ok: false, error: `Unknown source id ${id}. Use ids returned by web_search / web_fetch.` }
		if (meta.sourceType) c.suggestedType = meta.sourceType
		if (meta.publisher) c.publisher = meta.publisher
		const published = toDate(meta.publishedAt)
		if (meta.publishedAt && !published) return { ok: false, error: `published_at '${meta.publishedAt}' is not a date (use YYYY-MM-DD).` }
		if (published) c.publishedAt = published
		if (meta.originUrl) {
			const origin = this.observe({ url: meta.originUrl, tool: "manual" })
			if (!origin) return { ok: false, error: `original_source_url '${meta.originUrl}' is not a valid http(s) URL.` }
			if (origin.id === c.id) return { ok: false, error: "A source cannot be its own origin." }
			// Refuse cycles so origin chains always terminate.
			for (let o: Candidate | undefined = origin; o; o = o.originId ? this.byId.get(o.originId) : undefined) {
				if (o.id === c.id) return { ok: false, error: "That origin already cites this source (circular sourcing)." }
			}
			c.originId = origin.id
			this.commit(origin.id)
		}
		return { ok: true }
	}

	/** Promote a candidate to a contract Source in RunState (validates; re-emits when an already-committed source changes). */
	commit(id: string, ctx: { topicId?: string; slotId?: string } = {}): CommitResult {
		const c = this.byId.get(id)
		if (!c) return { ok: false, errors: [`Unknown source id ${id}`] }
		const type = resolveSourceType(c.url, c.suggestedType)
		const profile = this.deps.state.profile
		const source = compact({
			schema_version: "1.0",
			id: c.id,
			run_id: this.deps.state.runId,
			project_id: typeof profile?.project_id === "string" ? profile.project_id : undefined,
			url: c.url,
			title: c.title || undefined,
			publisher: c.publisher ?? (registrableHost(c.url) || undefined),
			published_at: c.publishedAt,
			retrieved_at: c.retrievedAt,
			tool: c.tool,
			source_type: type,
			reliability: scoreReliability({
				url: c.url,
				type,
				...(c.publishedAt ? { publishedAt: c.publishedAt } : {}),
				injectionFlagged: c.injectionPatterns.length > 0,
				secondhand: !!c.originId,
				now: this.deps.clock.now(),
			}),
			origin_id: c.originId,
			content_ref: c.contentRef,
			content_hash: c.contentHash,
			injection_flagged: c.injectionPatterns.length > 0,
		}) as Obj
		const valid = validateContract("source", source)
		if (!valid.ok) return { ok: false, errors: valid.errors }
		const previous = this.deps.state.sources.get(c.id)
		const changed = !previous || JSON.stringify(previous) !== JSON.stringify(source)
		this.deps.state.sources.set(c.id, source)
		c.committed = true
		if (changed) this.deps.emitter.emit(EV.SourceSubmitted, compact({ id: c.id, topicId: ctx.topicId, slotId: ctx.slotId, updated: previous ? true : undefined }))
		return { ok: true, source }
	}

	async readCleaned(id: string): Promise<string | undefined> {
		return this.deps.content.readCleaned(id)
	}

	/** Convenience for tools: scan arbitrary untrusted text and tag the candidate if it carries directives. */
	scan(c: Candidate, text: string, ctx: { topicId?: string; slotId?: string } = {}): InjectionScan {
		const result = scanForInjection(text)
		this.noteInjection(c, result, ctx)
		return result
	}
}
