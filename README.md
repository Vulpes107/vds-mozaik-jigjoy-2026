# vds-mozaik-jigjoy-2026

Agent app built on [`@mozaik-ai/core`](https://www.npmjs.com/package/@mozaik-ai/core) 4.1, with runs streamed to [Mozaik cloud](https://app.jigjoy.ai).

## Setup

**Devcontainer (recommended):** open the folder in VS Code and choose **Reopen in Container**. It uses Node 22 and runs `npm install` for you. Any `MOZAIK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` set on your host is passed into the container.

**Local:** Node 22+, then `npm install`.

## Keys

```bash
cp .example.env .env
```

Fill in the provider keys for the models you use (OpenAI, Anthropic, Gemini).

For Mozaik cloud, either set `MOZAIK_API_KEY=pk_…` in `.env` (create a project key at app.jigjoy.ai), or pair this machine:

```bash
npx @mozaik-ai/cloud-sdk pair
```

It prints an approve link. Open it where you're signed in to app.jigjoy.ai and the key is saved to `~/.mozaik/credentials.json`. In the devcontainer that file is lost when the container is rebuilt, so `.env` is the sturdier option there.

## Run

Mozaik cloud reads `.env` itself, but the provider SDKs don't, so load it with Node:

```bash
node --env-file=.env your-app.js
```

On core 4.x, events flow to Mozaik cloud automatically: a live link prints in the terminal and your agents appear under **Agents**.

## Project: market intelligence swarm

A multi-agent system that researches a company's market and produces a costed business plan, with dynamic agent allocation, built on Mozaik.

### Running a full pass

Keys in `.env` (copy `.example.env`): `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (the team gateway: Sonnet 4.6 and Haiku 4.5 only), `TAVILY_API_KEY` (search), optional `MOZAIK_API_KEY` (live view on app.jigjoy.ai). Then:

```bash
npm install && npm run check                                   # fixtures, types, 187 tests; no keys needed
node --env-file=.env --import tsx src/orchestrator/demo.ts     # one pass on mocks/company_profile.sample.json
node --env-file=.env --import tsx src/orchestrator/demo.ts path/to/profile.json 2 600   # cap: $2, 600 s
```

The demo auto-approves the topic list, prints every `AgentEvent` as it happens (`topics_proposed`, `agent_assigned`, `agent_reassigned`, `topic_dropped`, `budget_exhausted`, `plan_ready`, …), then the topic counts, spend, the plan's verdict, summary and recommendations. The full state is saved to `data/<run_id>.json`; the plan is `.plan` in that file.

**Budget.** `run_budget { usd, seconds }` (profile field, or the demo's 2nd/3rd argument; default `$2 / 30 min`) caps research: when it trips, no new tasks start, running tasks end at their next step, and analysis runs anyway on whatever was found (each analysis stage has its own 60k-token cap, about $0.2–0.5 for all three). Every task also has its own token/tool-call/time limit (`src/research/index.ts`). Rough guide on this gateway: `$0.50` gets you the topic list and scouting only; `$2–3` gets deep research on the top topics. Metered spend is printed as `spent.usd`; compare it with the gateway's counter now and then.

**With the dashboard / API** instead of the demo:

```bash
node --env-file=.env --import tsx src/orchestrator/server.ts   # http://localhost:8787, localhost only
curl -X POST localhost:8787/runs -d '{"profile": <CompanyProfile>}'          # -> { run_id }
curl localhost:8787/runs/<id>                                                 # status, budget, spend, slots, checkpoints
curl -X POST localhost:8787/runs/<id>/checkpoints/cp_topics -d '{"approved":true}'   # approve the topic list
curl -N localhost:8787/runs/<id>/events                                       # SSE stream (resumes with Last-Event-ID)
curl localhost:8787/runs/<id>/topics|findings|sources|assumptions|scenarios|plan
curl -X POST localhost:8787/runs/<id>/assumptions/as_001 -d '{"value": 0.08}' # edit an assumption; scenarios and plan recompute
```

One process hosts one run (`POST /runs` answers 409 while one is live). Crash recovery: `resumeRun(runId)` in `src/orchestrator/run.ts` restores from `data/<run_id>.json`.

- Design and Mozaik mapping: [`docs/MASTERPLAN.md`](docs/MASTERPLAN.md)
- Repo rules for every machine (read first): [`CLAUDE.md`](CLAUDE.md)
- Data contracts: [`contracts/`](contracts/README.md)
- Who is doing what: [`STATUS.md`](STATUS.md)

```bash
npm install
npm run check   # validate fixtures, typecheck, tests
```
