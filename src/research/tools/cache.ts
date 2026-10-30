// Cache of external calls keyed by a hash of (tool, args). Only public web content is shared this way;
// the key is computed on the already-redacted arguments, so nothing company-specific is a cache key.
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface CacheEntry {
	value: unknown
	storedAt: number
}

export interface CacheStore {
	get(key: string): Promise<CacheEntry | undefined>
	set(key: string, entry: CacheEntry): Promise<void>
}

/** JSON with sorted keys and undefined dropped, so equal arguments always hash equal. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
	if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`
	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

export function cacheKey(tool: string, args: unknown, provider = ""): string {
	return createHash("sha256").update(`${tool}\n${provider}\n${stableStringify(args)}`).digest("hex")
}

export class MemoryCache implements CacheStore {
	private map = new Map<string, CacheEntry>()
	async get(key: string): Promise<CacheEntry | undefined> {
		return this.map.get(key)
	}
	async set(key: string, entry: CacheEntry): Promise<void> {
		this.map.set(key, entry)
	}
	get size(): number {
		return this.map.size
	}
}

/** One JSON file per key under `dir` (default data/cache/web, gitignored). Writes are atomic via rename. */
export class FileCache implements CacheStore {
	constructor(private readonly dir: string) {}

	async get(key: string): Promise<CacheEntry | undefined> {
		try {
			return JSON.parse(await readFile(join(this.dir, `${key}.json`), "utf8")) as CacheEntry
		} catch {
			return undefined
		}
	}

	async set(key: string, entry: CacheEntry): Promise<void> {
		await mkdir(this.dir, { recursive: true })
		const tmp = join(this.dir, `${key}.${process.pid}.tmp`)
		await writeFile(tmp, JSON.stringify(entry))
		await rename(tmp, join(this.dir, `${key}.json`))
	}
}

/** Memory in front of an optional slower store. */
export class LayeredCache implements CacheStore {
	private readonly memory = new MemoryCache()
	constructor(private readonly backing?: CacheStore) {}

	async get(key: string): Promise<CacheEntry | undefined> {
		const hit = await this.memory.get(key)
		if (hit) return hit
		const stored = await this.backing?.get(key)
		if (stored) await this.memory.set(key, stored)
		return stored
	}

	async set(key: string, entry: CacheEntry): Promise<void> {
		await this.memory.set(key, entry)
		await this.backing?.set(key, entry)
	}
}
