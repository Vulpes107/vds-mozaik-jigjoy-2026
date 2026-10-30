# ADR 0002: SQLite run store (`better-sqlite3`)

Status: accepted (2026-10-30, Machine A)

Run snapshots move from one `data/<runId>.json` file per run to a single SQLite file, `data/mozaik.db` (gitignored). The `runs` table has one row per run: `run_id`, `project_id`, `company`, `status`, `saved_at`, `spent_usd` and the full snapshot as JSON. Rows are upserted by the existing debounced writer, so `snapshot()` / `restore()` and `resumeRun` are unchanged.

Why: MASTERPLAN §6 scopes work by project, and a project has many runs. Listing runs, filtering by project and finding the latest one are cheap queries on indexed columns and awkward on a folder of files. `GET /runs[?project_id=]` serves the dashboard's run history.

Choices:
- **`better-sqlite3`, not `node:sqlite`.** It is synchronous, which suits a single-process runtime, and its API is stable. `node:sqlite` is still experimental. It is a native module with prebuilt binaries for Node 22+ (the project baseline). Revisit `node:sqlite` once it is stable.
- **Snapshot stays a JSON column.** Normalised tables for findings, sources and assumptions would have to track every additive contract change. Add them only when a query across runs needs them.
- **Legacy files still resume.** `readSnapshot` falls back to `data/<runId>.json` when the database has no row.
- **Not moved:** the web-call cache (`data/cache/web`) and fetched source pages (`data/<runId>/sources/`) stay as files. They are B's, public-web only, and need no queries.

Out of scope, unchanged from ADR 0001: one process hosts one run, and there is no auth. `GET /runs` lists every run in the local database, so it needs per-project access control before the API is exposed beyond localhost.
