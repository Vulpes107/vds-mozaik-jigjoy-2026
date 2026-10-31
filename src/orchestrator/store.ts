// SQLite run store (ADR 0002): one row per run holding the latest snapshot, plus indexed columns for listing.
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

export interface RunRow {
	run_id: string
	project_id: string | null
	company: string | null
	status: string
	saved_at: string
	spent_usd: number
}

export interface SaveMeta {
	projectId?: string
	company?: string
	status: string
	spentUsd: number
}

export class RunStore {
	private readonly db: Database.Database

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
		this.db = new Database(path)
		this.db.pragma("journal_mode = WAL")
		this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
			run_id TEXT PRIMARY KEY,
			project_id TEXT,
			company TEXT,
			status TEXT NOT NULL,
			saved_at TEXT NOT NULL,
			spent_usd REAL NOT NULL DEFAULT 0,
			snapshot TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, saved_at DESC);`)
	}

	save(runId: string, savedAt: string, meta: SaveMeta, snapshotJson: string): void {
		this.db
			.prepare(
				`INSERT INTO runs (run_id, project_id, company, status, saved_at, spent_usd, snapshot)
				 VALUES (@runId, @projectId, @company, @status, @savedAt, @spentUsd, @snapshot)
				 ON CONFLICT (run_id) DO UPDATE SET project_id = @projectId, company = @company, status = @status,
				   saved_at = @savedAt, spent_usd = @spentUsd, snapshot = @snapshot`,
			)
			.run({ runId, projectId: meta.projectId ?? null, company: meta.company ?? null, status: meta.status, savedAt, spentUsd: meta.spentUsd, snapshot: snapshotJson })
	}

	/** Raw snapshot JSON, or undefined when the run is unknown. */
	load(runId: string): string | undefined {
		return (this.db.prepare("SELECT snapshot FROM runs WHERE run_id = ?").get(runId) as { snapshot: string } | undefined)?.snapshot
	}

	/** Newest first; optionally one project only. */
	list(projectId?: string): RunRow[] {
		const cols = "run_id, project_id, company, status, saved_at, spent_usd"
		return (projectId
			? this.db.prepare(`SELECT ${cols} FROM runs WHERE project_id = ? ORDER BY saved_at DESC`).all(projectId)
			: this.db.prepare(`SELECT ${cols} FROM runs ORDER BY saved_at DESC`).all()) as RunRow[]
	}

	close(): void {
		this.db.close()
	}
}

const stores = new Map<string, RunStore>()

/** One handle per database file for the life of the process. */
/** Where snapshots and the run database live; tests point it at a temp dir so they never show up as runs. */
export const dataDir = () => process.env.DATA_DIR ?? "data"

export function openStore(dir = dataDir()): RunStore {
	const path = dir === ":memory:" ? dir : join(dir, "mozaik.db")
	let s = stores.get(path)
	if (!s) stores.set(path, (s = new RunStore(path)))
	return s
}
