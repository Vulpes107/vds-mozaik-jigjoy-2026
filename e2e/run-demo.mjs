#!/usr/bin/env node
// E2E harness (Machine D). Runs the demo golden company against the mock server
// (and, with --real, against A's real orchestrator API on PORT) and checks the
// scripted hero moment -- a topic dropped and its agent reassigned -- is visible
// end to end, plus that the served plan/topics validate against contracts/.
// Report breakages to the owning machine in STATUS.md.
//
// Usage: node e2e/run-demo.mjs [--real]
import { spawn } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const useReal = process.argv.includes("--real")
const port = Number(process.env.PORT ?? 8787)
const base = `http://127.0.0.1:${port}`
const runId = "r_demo1"

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
addFormats(ajv)
for (const file of readdirSync(join(root, "contracts")).filter((f) => f.endsWith(".schema.json"))) {
	ajv.addSchema(JSON.parse(readFileSync(join(root, "contracts", file), "utf8")), file)
}
function validateAs(name, obj) {
	const v = ajv.getSchema(`${name}.schema.json`)
	if (!v(obj)) throw new Error(`${name} failed contract validation: ${ajv.errorsText(v.errors)}`)
}

function fail(step, detail) {
	console.error(`FAIL  ${step}: ${detail}`)
	process.exitCode = 1
}
function pass(step) {
	console.log(`OK    ${step}`)
}

async function waitForServer(url, tries = 40) {
	for (let i = 0; i < tries; i++) {
		try {
			const r = await fetch(url)
			if (r.ok || r.status === 404) return
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	throw new Error(`server at ${url} never came up`)
}

async function main() {
	let child
	if (!useReal) {
		child = spawn(process.execPath, [join(root, "dashboard", "mock-server", "server.mjs")], {
			env: { ...process.env, PORT: String(port), MOCK_SPEED: "200" },
			stdio: "inherit",
		})
	}
	try {
		await waitForServer(`${base}/runs/${runId}`)

		const run = await (await fetch(`${base}/runs/${runId}`)).json()
		run.run_id === runId ? pass("GET /runs/:id returns the run") : fail("GET /runs/:id", JSON.stringify(run))

		const topics = await (await fetch(`${base}/runs/${runId}/topics`)).json()
		Array.isArray(topics) && topics.length > 0 ? pass("GET topics returns a non-empty list") : fail("GET topics", "empty")
		for (const t of topics) {
			try {
				validateAs("topic", t)
			} catch (e) {
				fail("topic contract", e.message)
			}
		}

		// Watch the SSE stream for the hero moment: a drop followed by a reassignment
		// of the same agent onto another topic.
		const seen = []
		const es = await fetch(`${base}/runs/${runId}/events`)
		const reader = es.body.getReader()
		const decoder = new TextDecoder()
		const deadline = Date.now() + 8000
		let buf = ""
		while (Date.now() < deadline) {
			const { value, done } = await Promise.race([
				reader.read(),
				new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 300)),
			])
			if (done) break
			if (value) buf += decoder.decode(value, { stream: true })
			let idx
			while ((idx = buf.indexOf("\n\n")) !== -1) {
				const chunk = buf.slice(0, idx)
				buf = buf.slice(idx + 2)
				const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "))
				if (dataLine) seen.push(JSON.parse(dataLine.slice(6)))
			}
			const dropped = seen.find((e) => e.type === "topic_dropped")
			const reassigned = seen.find((e) => e.type === "agent_reassigned" && e.agent_id === dropped?.agent_id)
			if (dropped && reassigned) break
		}
		reader.cancel().catch(() => {})

		const dropped = seen.find((e) => e.type === "topic_dropped")
		const reassigned = seen.find((e) => e.type === "agent_reassigned" && e.agent_id === dropped?.agent_id)
		dropped ? pass("SSE stream emits topic_dropped") : fail("SSE topic_dropped", `only saw: ${seen.map((e) => e.type).join(",")}`)
		reassigned
			? pass("SSE stream reassigns the same agent to another topic")
			: fail("SSE agent_reassigned", `agent ${dropped?.agent_id} was not reassigned`)

		const plan = await fetch(`${base}/runs/${runId}/plan`)
		if (plan.ok) {
			try {
				validateAs("business_plan", await plan.json())
				pass("plan validates against contracts/business_plan.schema.json")
			} catch (e) {
				fail("plan contract", e.message)
			}
		} else {
			pass("plan not ready yet (acceptable mid-run state)")
		}

		// Privacy check: nothing that looks like a secret/API key leaking through the API.
		const dump = JSON.stringify({ run, topics, seen })
		if (/sk-[A-Za-z0-9]{10,}|tvly-[A-Za-z0-9]{10,}/.test(dump)) fail("privacy check", "looks like an API key leaked into API output")
		else pass("privacy check: no API-key-shaped strings in API output")
	} finally {
		child?.kill()
	}
}

main().catch((e) => {
	fail("harness", e.stack ?? String(e))
})
