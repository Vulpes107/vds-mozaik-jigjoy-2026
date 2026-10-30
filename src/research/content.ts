// Raw + cleaned page text per source, referenced from Source.content_ref (blob://<run>/<source>.md).
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export interface StoredContent {
	raw: string
	cleaned: string
}

export interface ContentStore {
	/** Returns the content_ref to put on the Source. */
	put(runId: string, sourceId: string, content: StoredContent): Promise<string>
	/** Cleaned text (what analysts may read). */
	readCleaned(sourceId: string): Promise<string | undefined>
}

export class MemoryContentStore implements ContentStore {
	readonly items = new Map<string, StoredContent>()
	async put(runId: string, sourceId: string, content: StoredContent): Promise<string> {
		this.items.set(sourceId, content)
		return `blob://${runId}/${sourceId}.md`
	}
	async readCleaned(sourceId: string): Promise<string | undefined> {
		return this.items.get(sourceId)?.cleaned
	}
}

/** Writes under `<root>/<runId>/sources/` (root defaults to data/, gitignored). */
export class FileContentStore implements ContentStore {
	private readonly byId = new Map<string, string>()
	constructor(private readonly root: string = resolve("data")) {}

	async put(runId: string, sourceId: string, content: StoredContent): Promise<string> {
		const base = join(this.root, safeSegment(runId), "sources", safeSegment(sourceId))
		await mkdir(dirname(base), { recursive: true })
		await writeFile(`${base}.md`, content.cleaned)
		await writeFile(`${base}.raw.txt`, content.raw)
		this.byId.set(sourceId, `${base}.md`)
		return `blob://${runId}/${sourceId}.md`
	}

	async readCleaned(sourceId: string): Promise<string | undefined> {
		const path = this.byId.get(sourceId)
		if (!path) return undefined
		try {
			return await readFile(path, "utf8")
		} catch {
			return undefined
		}
	}
}

const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_")
