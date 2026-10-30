// Validate analysis outputs against the JSON Schemas in /contracts, through the shared validator (A).
import { validate, type SchemaName } from "../shared/validate.ts"

export type { SchemaName }

export function assertValid(name: SchemaName, value: unknown): void {
	const err = validate(name, value)
	if (err) throw new Error(`Invalid ${name}: ${err.split("\n").slice(0, 6).join("; ")}`)
}

export function isValid(name: SchemaName, value: unknown): boolean {
	return validate(name, value) === null
}
