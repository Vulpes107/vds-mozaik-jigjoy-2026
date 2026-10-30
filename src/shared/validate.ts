// Contract validation for code (contracts/validate.mjs is the CLI twin). Every object that
// crosses a machine boundary goes through `validate` on write and on read.
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"
import addFormatsModule from "ajv-formats"
import type { Ajv } from "ajv"

// ajv-formats ships CommonJS with a default export; under NodeNext the import is the module namespace.
const addFormats = (addFormatsModule as unknown as { default: (ajv: Ajv) => void }).default

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts")

// strictRequired off: conditional `required` refers to properties declared in the parent schema.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
addFormats(ajv)
for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"))) {
	ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, file), "utf8")), file)
}

export type SchemaName = "company_profile" | "topic" | "source" | "finding" | "assumption" | "scenario" | "agent_event" | "business_plan"

/** Returns null when valid, otherwise one readable line per error (suitable for returning to an LLM tool call). */
export function validate(schema: SchemaName, obj: unknown): string | null {
	const fn = ajv.getSchema(`${schema}.schema.json`)
	if (!fn) throw new Error(`unknown schema ${schema}`)
	if (fn(obj)) return null
	return (fn.errors ?? []).map((e: { instancePath: string; message?: string; params?: Record<string, unknown> }) => `${e.instancePath || "<root>"} ${e.message}${e.params?.allowedValues ? ` (${(e.params.allowedValues as string[]).join(", ")})` : ""}`).join("\n")
}
