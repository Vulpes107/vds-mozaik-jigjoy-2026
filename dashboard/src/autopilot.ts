// Hands-free demo: open `/?auto=1` against `MOCK_DEMO=1` and the page drives itself (fill form, start, approve,
// scroll to each section in step with the scripted run, drag the price slider) so the presenter only talks.
// Timings are seconds after Approve and match docs/DEMO.md. Adds no dependencies and does nothing without the flag.
const KEY = "autopilot"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const byText = (sel: string, text: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === text)
async function waitFor<T>(get: () => T | undefined | null, ms = 60_000): Promise<T | undefined> {
	const end = Date.now() + ms
	while (Date.now() < end) {
		const v = get()
		if (v) return v
		await sleep(250)
	}
}
const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })

/** Move a React-controlled range input the way a user drags it, in small steps. */
async function drag(input: HTMLInputElement, to: number, ms: number) {
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
	const from = Number(input.value)
	const steps = 40
	for (let i = 1; i <= steps; i++) {
		set.call(input, String(from + ((to - from) * i) / steps))
		input.dispatchEvent(new Event("input", { bubbles: true }))
		await sleep(ms / steps)
	}
}

async function landing() {
	await sleep(2500)
	byText("button", "Use recommended values")?.click()
	await sleep(3000)
	byText("button", "Start run")?.click()
}

async function runPage() {
	window.scrollTo({ top: 0 })
	const approve = await waitFor(() => byText("button", "Approve"))
	await sleep(5000) // let the checkpoint banner be seen
	approve?.click()
	const t0 = Date.now()
	const at = async (s: number) => sleep(Math.max(0, s * 1000 - (Date.now() - t0)))

	await at(1); go("activity") //  agents spawn, topics scored
	await at(20); go("research") //  t_002 dropped, a_03 reassigned
	await at(26); go("activity")
	await at(32) // plan appears; the section order changes, so wait for the recommendation to exist
	await waitFor(() => document.getElementById("recommend"), 15_000)
	window.scrollTo({ top: 0, behavior: "smooth" }) //  verdict + KPI strip
	await at(40); go("recommend")
	await at(46); byText("button", "Why this?")?.click()
	await at(54); go("finance")
	await at(58)
	const price = document.querySelector<HTMLInputElement>('input[type="range"][aria-label^="Average price"]')
	if (price) await drag(price, Math.min(Number(price.max), 41), 8000) //  verdict flips below ~45 EUR
	await at(72); window.scrollTo({ top: 0, behavior: "smooth" })
	await at(78); go("risks")
	await at(86); go("evidence")
	await at(90); window.scrollTo({ top: 0, behavior: "smooth" })
	sessionStorage.removeItem(KEY)
}

export function startAutopilot(isRunPage: boolean) {
	if (new URLSearchParams(location.search).get("auto") === "1") sessionStorage.setItem(KEY, "1")
	if (sessionStorage.getItem(KEY) !== "1") return
	void (isRunPage ? runPage() : landing()).catch((e) => console.warn("autopilot stopped", e))
}
