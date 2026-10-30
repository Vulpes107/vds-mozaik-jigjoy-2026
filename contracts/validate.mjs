#!/usr/bin/env node
// Validate every fixture in /mocks against its schema in /contracts.
//
// Fixture naming: mocks/<schema_name>.<variant>.json  (e.g. mocks/topic.dropped.json)
// A fixture file may hold one object or an array of objects.
//
// Usage: node contracts/validate.mjs [files...]   (default: all of mocks/)
import { readFileSync, readdirSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const schemaDir = join(root, "contracts")
const mockDir = join(root, "mocks")

// strictRequired off: conditional `required` legitimately refers to properties declared in the parent schema.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
addFormats(ajv)

const schemaNames = new Set()
for (const file of readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"))) {
	const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8"))
	// Register under the file name so relative refs (common.schema.json#/$defs/...) resolve.
	ajv.addSchema(schema, file)
	schemaNames.add(file.replace(".schema.json", ""))
}

const targets = process.argv.slice(2).length
	? process.argv.slice(2)
	: readdirSync(mockDir).filter((f) => f.endsWith(".json")).map((f) => join(mockDir, f))

let failures = 0
for (const path of targets) {
	const name = basename(path).split(".")[0]
	if (!schemaNames.has(name)) {
		console.log(`SKIP  ${basename(path)}: no schema named '${name}'`)
		continue
	}
	const validate = ajv.getSchema(`${name}.schema.json`)
	const data = JSON.parse(readFileSync(path, "utf8"))
	const items = Array.isArray(data) ? data : [data]
	let fileFailures = 0
	items.forEach((item, i) => {
		if (!validate(item)) {
			for (const e of validate.errors ?? []) {
				fileFailures++
				console.log(`FAIL  ${basename(path)}[${i}] ${e.instancePath || "<root>"}: ${e.message}`)
			}
		}
	})
	failures += fileFailures
	if (!fileFailures) console.log(`OK    ${basename(path)} (${items.length})`)
}
process.exit(failures ? 1 : 0)
