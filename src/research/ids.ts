import type { RunState } from "../shared/runtime.ts"

/** `<prefix>_<NNN>` ids, seeded from what is already in RunState so a resumed run never collides. */
export class IdGenerator {
	private counters = new Map<string, number>()

	constructor(state: Pick<RunState, "sources" | "findings">) {
		for (const id of state.sources.keys()) this.seed(id)
		for (const id of state.findings.keys()) this.seed(id)
	}

	private seed(id: string): void {
		const m = /^([a-z]{1,4})_(\d+)$/.exec(id)
		if (!m) return
		const prefix = m[1]!
		const n = Number(m[2])
		if (n > (this.counters.get(prefix) ?? 0)) this.counters.set(prefix, n)
	}

	next(prefix: "s" | "f"): string {
		const n = (this.counters.get(prefix) ?? 0) + 1
		this.counters.set(prefix, n)
		return `${prefix}_${String(n).padStart(3, "0")}`
	}
}

/** Contract ids are `<prefix>_<alnum>`. Slot ids are chosen by the Allocator, so normalise before using one as a reference. */
export function agentRef(slotId: string): string {
	if (/^[a-z]{1,4}_[A-Za-z0-9]+$/.test(slotId)) return slotId
	return `a_${slotId.replace(/[^A-Za-z0-9]/g, "") || "x"}`
}
