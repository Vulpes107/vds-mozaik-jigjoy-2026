import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModels } from "./models.ts"

test("the repository's config/models.json resolves for every research role", () => {
	const m = loadModels()
	for (const role of ["scout", "collector", "analyst", "verifier"] as const) assert.equal(typeof m[role], "string")
})

test("an unsupported model name fails early with the role in the message", () => {
	const dir = mkdtempSync(join(tmpdir(), "b-models-"))
	const path = join(dir, "models.json")
	writeFileSync(path, JSON.stringify({ scout: "claude-haiku-4-5", collector: "nope-9", analyst: "claude-sonnet-5-5", verifier: "claude-sonnet-5-5" }))
	assert.throws(() => loadModels(path), /collector.*nope-9|nope-9.*collector/)
	writeFileSync(path, JSON.stringify({ scout: "claude-haiku-4-5" }))
	assert.throws(() => loadModels(path), /no model for role/)
})
