import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { AgentEvent, Topic } from "../types/contracts.ts"
import { allocationAt, droppedAt, moveStory } from "../derive.ts"
import { label } from "../fmt.ts"
import { Glyph, Section, roleStyle } from "../ui.tsx"

const FEED_SHOWN = 8
const ROLES = ["scout", "collector", "analyst", "verifier"]
const ev = (e: AgentEvent) => label(e.type)

/** FLIP: remember where each agent chip was, then glide it from there to its new lane. */
function useGlide(deps: unknown) {
	const refs = useRef(new Map<string, HTMLElement>())
	const prev = useRef(new Map<string, DOMRect>())
	useLayoutEffect(() => {
		const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
		const next = new Map<string, DOMRect>()
		refs.current.forEach((el, id) => {
			const r = el.getBoundingClientRect()
			next.set(id, r)
			const p = prev.current.get(id)
			if (!reduce && p && (Math.abs(p.left - r.left) > 2 || Math.abs(p.top - r.top) > 2)) {
				el.animate([{ transform: `translate(${p.left - r.left}px, ${p.top - r.top}px)` }, { transform: "none" }], { duration: 240, easing: "ease-out" })
			}
		})
		prev.current = next
	}, [deps])
	return (id: string) => (el: HTMLElement | null) => {
		if (el) refs.current.set(id, el)
		else refs.current.delete(id)
	}
}

export function Activity({ events, topics }: { events: AgentEvent[]; topics: Topic[] }) {
	const [pos, setPos] = useState<number | null>(null) // null = follow live
	const [allEvents, setAllEvents] = useState(false)
	const upTo = pos ?? events.length
	const agents = useMemo(() => allocationAt(events, topics, upTo), [events, topics, upTo])
	const gone = useMemo(() => droppedAt(events, upTo), [events, upTo])
	const reg = useGlide(agents.map((a) => `${a.id}:${a.topicId}`).join("|"))
	const lastMoved = events.slice(0, upTo).filter((e) => e.type === "agent_reassigned").at(-1)?.agent_id
	const t0 = events[0] ? Date.parse(events[0].ts) : 0
	const clock = (e: AgentEvent) => { const s = Math.round((Date.parse(e.ts) - t0) / 1000); return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` }
	const byId = new Map(topics.map((t) => [t.id, t]))
	const lanes = topics.filter((t) => t.state !== "queued" || agents.some((a) => a.topicId === t.id) || gone.has(t.id))
	const idle = agents.filter((a) => !a.topicId || !byId.has(a.topicId))
	const shown = events.slice(0, upTo)
	return (
		<Section id="activity" title="The agents at work" lede="Workers are assigned to research topics by priority. When a topic turns out to be irrelevant it is dropped, and its worker moves to the topic where it helps most." keep>
			{events.length > 0 && (
				<div className="replay">
					<button className="btn" onClick={() => setPos(pos === null ? events.length : null)} aria-pressed={pos === null}>{pos === null ? "Following live" : "Go live"}</button>
					<label className="sr" htmlFor="scrub">Replay position</label>
					<input id="scrub" type="range" min={0} max={events.length} value={upTo} onChange={(e) => setPos(Number(e.target.value))} />
					<span className="num">{upTo}/{events.length}</span>
				</div>
			)}
			<div className="legend" aria-label="Agent roles">
				{ROLES.map((r) => <span key={r}><Glyph role={r} />{r}</span>)}
				<span><Glyph role="other" />other</span>
			</div>
			{moveStory(events, upTo) && <p className="callout"><b>Latest reassignment.</b> {moveStory(events, upTo)}</p>}
			<div className="activity">
				<div>
					<h3 className="sub">Event feed (newest first)</h3>
					{shown.length === 0 ? <p className="note">No events yet. Agents start once you approve the topic list.</p> : (
						<ol className="feed" aria-live="polite" aria-label="Agent events">
							{[...shown].reverse().slice(0, allEvents ? undefined : FEED_SHOWN).map((e, i) => (
								<li key={e.seq ?? i}>
									<span className="t">{clock(e)}</span>
									<span>
										<span className="ty">{ev(e)}</span> <span className="dim">{e.agent_id ? `${e.agent_id} (${e.agent_role ?? "agent"})` : ""}</span>
										{e.detail && <div className="dim">{e.detail}</div>}
										{(e.from_topic_id || e.topic_id) && <div className="dim">{e.from_topic_id ? `${e.from_topic_id} → ` : ""}{e.topic_id}</div>}
									</span>
								</li>
							))}
						</ol>
					)}
					{shown.length > FEED_SHOWN && <button className="btn link" style={{ marginTop: 10 }} onClick={() => setAllEvents(!allEvents)}>{allEvents ? "Show only the latest" : `Show all ${shown.length} events`}</button>}
				</div>
				<div>
					<h3 className="sub">Who is working on what</h3>
					<div className="lanes">
						{lanes.map((t) => {
							const here = agents.filter((a) => a.topicId === t.id)
							const isGone = gone.has(t.id) || t.state === "dropped"
							return (
								<div key={t.id} className={`lane${isGone ? " gone" : ""}`}>
									<div className="tt">{t.title}<small>{t.id} · {isGone ? "dropped" : label(t.state)}{t.priority !== undefined && !isGone ? ` · priority ${t.priority.toFixed(2)}` : ""}</small></div>
									<div className="slots">
										{here.map((a) => (
											<span key={a.id} ref={reg(a.id)} className={`agent${a.id === lastMoved ? " moved" : ""}`} style={{ borderLeft: `3px solid ${roleStyle(a.role).color}` }}>
												<Glyph role={a.role} />{a.id}
											</span>
										))}
										{here.length === 0 && <span className="note">{isGone ? "no agents" : "unstaffed"}</span>}
									</div>
								</div>
							)
						})}
						{idle.length > 0 && (
							<div className="lane">
								<div className="tt">Idle<small>waiting for an assignment</small></div>
								<div className="slots">{idle.map((a) => <span key={a.id} ref={reg(a.id)} className="agent"><Glyph role={a.role} />{a.id}</span>)}</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</Section>
	)
}
