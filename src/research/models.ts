// Model ids come only from config/models.json (owned by A). We read the roles we use and fail early on a name that
// @mozaik-ai/core does not support, instead of letting the first inference call return a 400.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { supportedModels } from "@mozaik-ai/core"
import type { WorkerRole } from "../shared/events.ts"

export type ModelConfig = Record<WorkerRole, string>

const configPath = fileURLToPath(new URL("../../config/models.json", import.meta.url))

export function loadModels(path = configPath, supported: string[] = supportedModels.map((m) => m.specification.name)): ModelConfig {
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	const out = {} as ModelConfig
	for (const role of ["scout", "collector", "analyst", "verifier"] as const) {
		const name = raw[role]
		if (typeof name !== "string") throw new Error(`config/models.json has no model for role '${role}'`)
		if (!supported.includes(name)) throw new Error(`config/models.json: '${name}' (role ${role}) is not in supportedModels of @mozaik-ai/core`)
		out[role] = name
	}
	return out
}
