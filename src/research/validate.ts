// Ajv validators for the contracts B writes. Loaded once from /contracts.
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import * as AjvModule from "ajv/dist/2020.js"
import * as FormatsModule from "ajv-formats"

// ajv ships CommonJS; under NodeNext the default import is the module namespace, so unwrap it.
const Ajv2020 = ((AjvModule as unknown as { default: unknown }).default ?? AjvModule) as new (opts: object) => AjvLike
const addFormats = ((FormatsModule as unknown as { default: unknown }).default ?? FormatsModule) as (ajv: AjvLike) => void

interface ValidateFn {
	(data: unknown): boolean
	errors?: { instancePath: string; message?: string; params?: Record<string, unknown> }[] | null
}
interface AjvLike {
	addSchema(schema: object, key: string): void
	getSchema(key: string): ValidateFn | undefined
}

const schemaDir = fileURLToPath(new URL("../../contracts/", import.meta.url))
let ajv: AjvLike | undefined

function load(): AjvLike {
	if (ajv) return ajv
	// strictRequired off, same as contracts/validate.mjs: conditional `required` refers to parent properties.
	const instance = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
	addFormats(instance)
	for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"))) {
		instance.addSchema(JSON.parse(readFileSync(join(schemaDir, file), "utf8")), file)
	}
	ajv = instance
	return instance
}

export type ContractName = "finding" | "source" | "topic" | "company_profile"

export type Validation = { ok: true } | { ok: false; errors: string[] }

/** Readable messages so an LLM tool can return them and let the model correct itself. */
export function validateContract(name: ContractName, data: unknown): Validation {
	const validate = load().getSchema(`${name}.schema.json`)
	if (!validate) throw new Error(`No schema registered for ${name}`)
	if (validate(data)) return { ok: true }
	const errors = (validate.errors ?? []).map((e) => {
		const where = e.instancePath ? e.instancePath.replace(/^\//, "").replace(/\//g, ".") : "(object)"
		const extra = e.params && "additionalProperty" in e.params ? ` '${String(e.params.additionalProperty)}'` : ""
		return `${where}: ${e.message ?? "invalid"}${extra}`
	})
	return { ok: false, errors }
}
