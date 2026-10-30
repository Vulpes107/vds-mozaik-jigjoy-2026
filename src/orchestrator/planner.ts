// Topic Planner: turns the CompanyProfile into a short list of scored topics on the task board.
// The model never writes RunState directly; it calls submit_topics, which validates and stores.
import { readFileSync } from "node:fs"
import { SemanticEvent, SituationSpecification, createAgent, type SituationContext, type Tool } from "@mozaik-ai/core"
import { EV } from "../shared/events.ts"
import { join as joinRuntime, resolveRuntime, runLoop, sendEvent, type Obj } from "../shared/runtime.ts"
import { validate } from "../shared/validate.ts"

const models = JSON.parse(readFileSync(new URL("../../config/models.json", import.meta.url), "utf8")) as Record<string, string>

export const CATEGORIES = [
	"market", "customers", "competitors", "pricing", "technology", "regulation", "supply_chain", "talent",
	"funding", "channels", "macro", "brand", "esg", "ip", "existing_solutions", "cyber_ops",
] as const

// Sized for the hackathon budget: scouting alone costs ~1-2 cents per topic, deep work far more.
export const MIN_TOPICS = 10
export const MAX_TOPICS = 15

const INSTRUCTION = `You are the Topic Planner of a market-intelligence system. Given a company profile, produce the research agenda:
${MIN_TOPICS} to ${MAX_TOPICS} topics, each a concrete question whose answer could change the company's plan.
Cover each category in [${CATEGORIES.join(", ")}] that matters for this company; list every other category in skipped_categories with a one-line reason. Prefer fewer, sharper topics.
Merge overlapping topics. For multi-product profiles set product_scope per topic; leave it empty for company-wide topics.
importance_prior is your 0–1 estimate of how much the plan depends on this topic. Use depends_on only for real prerequisites.
Call submit_topics exactly once with the full list. If it returns validation errors, fix them and call it again.
Never invent facts about the company; plan questions, do not answer them.`

interface Proposed {
	title: string
	question: string
	category: string
	importance_prior: number
	product_scope?: string[]
	depends_on?: string[]
}

/** Builds the tool bound to the current run. Exported so it can be tested without an LLM. */
export function makeSubmitTopics(producerId: () => string): Tool {
	return {
		type: "function",
		name: "submit_topics",
		description: "Submit the complete research agenda. Returns 'ok' or validation errors to fix.",
		strict: false,
		parameters: {
			type: "object",
			required: ["topics", "skipped_categories"],
			properties: {
				topics: {
					type: "array",
					items: {
						type: "object",
						required: ["title", "question", "category", "importance_prior"],
						properties: {
							title: { type: "string" },
							question: { type: "string" },
							category: { type: "string", enum: [...CATEGORIES, "other"] },
							importance_prior: { type: "number", minimum: 0, maximum: 1 },
							product_scope: { type: "array", items: { type: "string" } },
							depends_on: { type: "array", items: { type: "string" }, description: "Titles of prerequisite topics in this same list." },
						},
					},
				},
				skipped_categories: {
					type: "array",
					items: { type: "object", required: ["category", "reason"], properties: { category: { type: "string" }, reason: { type: "string" } } },
				},
			},
		},
		invoke: async (args: { topics: Proposed[]; skipped_categories: { category: string; reason: string }[] }) => {
			const state = resolveRuntime().state
			const list = (args.topics ?? []).slice(0, MAX_TOPICS)
			const idByTitle = new Map(list.map((t, i) => [t.title, `t_${String(i + 1).padStart(3, "0")}`]))
			const now = new Date().toISOString()
			const topics: Obj[] = list.map((t) => ({
				schema_version: "1.0",
				id: idByTitle.get(t.title)!,
				run_id: state.runId,
				title: t.title,
				question: t.question,
				category: t.category,
				state: "queued",
				importance_prior: t.importance_prior,
				product_scope: t.product_scope ?? [],
				depends_on: (t.depends_on ?? []).map((d) => idByTitle.get(d)).filter((x): x is string => !!x),
				proposed_by: "planner",
				reassignment_count: 0,
				created_at: now,
				updated_at: now,
			}))
			const errors = topics.flatMap((t, i) => {
				const e = validate("topic", t)
				return e ? [`topics[${i}] (${t.title}): ${e}`] : []
			})
			const covered = new Set(list.map((t) => t.category))
			const skipped = new Set((args.skipped_categories ?? []).map((s) => s.category))
			for (const c of CATEGORIES) if (!covered.has(c) && !skipped.has(c)) errors.push(`category '${c}' is neither covered nor in skipped_categories`)
			if (list.length < MIN_TOPICS) errors.push(`only ${list.length} topics; produce at least ${MIN_TOPICS}`)
			if ((args.topics ?? []).length > MAX_TOPICS) errors.push(`${args.topics.length} topics; at most ${MAX_TOPICS}, merge or drop the weakest`)
			if (errors.length) return { status: "invalid", errors }

			state.topics.clear()
			for (const t of topics) state.topics.set(t.id, t)
			sendEvent(SemanticEvent.create(EV.TopicsProposed, producerId(), { topicIds: topics.map((t) => t.id), skipped: args.skipped_categories ?? [] }), producerId())
			return { status: "ok", count: topics.length }
		},
	}
}

class WhenRunStarted extends SituationSpecification {
	isSatisfiedBy({ event }: SituationContext): boolean {
		return event.type === EV.RunStarted
	}
}

/** Creates and joins the Planner. It plans when `run.started` arrives and RunState.profile is set. */
export function startPlanner() {
	let id = ""
	const agent = createAgent({
		name: "Planner",
		capabilities: ["planning"],
		instruction: INSTRUCTION,
		tools: [makeSubmitTopics(() => id)],
		handlers: [
			{
				specification: new WhenRunStarted(),
				processor: {
					apply: () => {
						const { profile } = resolveRuntime().state
						if (!profile) return
						runLoop(agent.getId(), `Company profile:\n${JSON.stringify(profile, null, 2)}`, {
							model: models.planner!,
							maxOutputTokens: 8000,
							tools: agent.getTools(),
							context: agent.getMemory().getContext(),
						})
					},
				},
			},
		],
	})
	id = agent.getId()
	joinRuntime(agent)
	return agent
}
