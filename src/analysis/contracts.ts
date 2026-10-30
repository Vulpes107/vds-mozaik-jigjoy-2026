// Validate analysis outputs against the real JSON Schemas in /contracts (Ajv, same settings as contracts/validate.mjs).
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js"
import addFormatsModule, { type FormatsPlugin } from "ajv-formats"

type SchemaName = "assumption" | "scenario" | "business_plan" | "finding" | "topic" | "company_profile" | "source" | "agent_event"

const dir = fileURLToPath(new URL("../../contracts/", import.meta.url))

// ajv-formats is CommonJS: under NodeNext the plugin is the module itself at runtime and `.default` in the types.
const addFormats = ((addFormatsModule as unknown as { default?: FormatsPlugin }).default ?? addFormatsModule) as unknown as FormatsPlugin

let ajv: Ajv2020 | undefined

function instance() {
	if (ajv) return ajv
	const a = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
	addFormats(a)
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) {
		a.addSchema(JSON.parse(readFileSync(join(dir, file), "utf8")), file)
	}
	return (ajv = a)
}

/** Throws an Error with readable, model-fixable messages when `value` does not match the contract. */
export function assertValid(name: SchemaName, value: unknown): void {
	const validate = instance().getSchema(`${name}.schema.json`)
	if (!validate) throw new Error(`No schema named ${name}`)
	if (validate(value)) return
	const msgs = (validate.errors ?? []).slice(0, 6).map((e: ErrorObject) => `${e.instancePath || "<root>"}: ${e.message}`)
	throw new Error(`Invalid ${name}: ${msgs.join("; ")}`)
}

export function isValid(name: SchemaName, value: unknown): boolean {
	try {
		assertValid(name, value)
		return true
	} catch {
		return false
	}
}
