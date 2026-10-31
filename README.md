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

### Tavily (web search, required for real runs)

The research agents search and read the web through [Tavily](https://tavily.com) (`@tavily/core`, installed by `npm install`). Without `TAVILY_API_KEY` a real run cannot research anything; the mock server and `npm run check` need no key.

Get a key at app.tavily.com and put it in `.env`. A free key has a small monthly quota and one full run uses a few hundred calls, so you can list **several keys, comma-separated**:

```bash
TAVILY_API_KEY=tvly-key1,tvly-key2,tvly-key3
```

Keys are used one after another: every call goes to the current key, and when it fails with a quota/rate-limit or auth error the next key takes over and the call is retried there (`withKeyFailover` in `src/research/tools/tavily.ts`). If every key is exhausted, search falls back to Parallel's free Search MCP (no key needed; `PARALLEL_API_KEY` only raises its rate limit). `map`/`crawl`/`research` exist only on Tavily, so those stop working when the Tavily keys run out.

Each machine uses its own keys. `.env` always wins over variables exported in your shell (the server logs which ones it overrode), so a stale `TAVILY_API_KEY` in your shell profile is ignored.

## Start the app

Two processes: the API server (orchestrator + agents, port 8787) and the dashboard (Vite, port 5173, proxies `/runs` to 8787). Run both from the repo root, in the devcontainer or locally:

```bash
npm install && (cd dashboard && npm install)                    # once
node --env-file=.env --import tsx src/orchestrator/server.ts   # terminal 1: API on http://localhost:8787
cd dashboard && npm run dev                                     # terminal 2: open http://localhost:5173
```

Then in the browser: fill in the company form (the run limits default to the recommended values; **Use recommended values** fills the rest), press **Start run**, approve the topic list when the banner asks, and the plan appears when research and analysis finish. Previous runs are listed beside the form.

- **No keys, UI only:** start `node dashboard/mock-server/server.mjs` instead of the API server. It serves the fixtures in `mocks/` and replays a recorded run.
- **One run at a time:** the server hosts one live run; starting another while it runs offers to stop the old one.
- **Stop:** Ctrl+C in both terminals. Finished runs are kept in `data/mozaik.db` and stay readable after a restart. Restart the server after pulling code changes; it does not reload.

## Run

Mozaik cloud reads `.env` itself, but the provider SDKs don't, so load it with Node:

```bash
node --env-file=.env your-app.js
```

On core 4.x, events flow to Mozaik cloud automatically: a live link prints in the terminal and your agents appear under **Agents**.

## Project: market intelligence swarm

A multi-agent system that researches a company's market and produces a costed business plan, with dynamic agent allocation, built on Mozaik.

### Running a full pass

Keys in `.env` (copy `.example.env`): `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (the team gateway: Sonnet 4.6 and Haiku 4.5 only), `TAVILY_API_KEY` (search, one or more keys; see [Tavily](#tavily-web-search-required-for-real-runs)), optional `MOZAIK_API_KEY` (live view on app.jigjoy.ai). Then:

```bash
npm install && npm run check                                   # fixtures, types, 187 tests; no keys needed
node --env-file=.env --import tsx src/orchestrator/demo.ts     # one pass on mocks/company_profile.sample.json
node --env-file=.env --import tsx src/orchestrator/demo.ts path/to/profile.json 2 600   # cap: $2, 600 s
```

The demo auto-approves the topic list, prints every `AgentEvent` as it happens (`topics_proposed`, `agent_assigned`, `agent_reassigned`, `topic_dropped`, `budget_exhausted`, `plan_ready`, …), then the topic counts, spend, the plan's verdict, summary and recommendations. The full state is saved to `data/mozaik.db` (SQLite, table `runs`, the `snapshot` column is JSON; the plan is `.plan` in it).

**Budget.** `run_budget { usd, seconds }` (profile field, or the demo's 2nd/3rd argument; default `$4 / 30 min`) caps research: when it trips, no new tasks start, running tasks end at their next step, and analysis runs anyway on whatever was found (each analysis stage has its own 60k-token cap, about $0.2–0.5 for all three). Every task also has its own token/tool-call/time limit (`src/research/index.ts`). Rough guide on this gateway: `$0.50` gets you the topic list and scouting only; `$2–3` gets deep research on the top topics. Metered spend is printed as `spent.usd`; compare it with the gateway's counter now and then.

**With the dashboard / API** instead of the demo:

```bash
node --env-file=.env --import tsx src/orchestrator/server.ts   # http://localhost:8787, localhost only
curl -X POST localhost:8787/runs -d '{"profile": <CompanyProfile>}'          # -> { run_id }
curl localhost:8787/runs[?project_id=p_x]                                           # run history from the database, newest first
curl localhost:8787/runs/<id>                                                 # status, budget, spend, slots, checkpoints
curl -X POST localhost:8787/runs/<id>/checkpoints/cp_topics -d '{"approved":true}'   # approve the topic list
curl -N localhost:8787/runs/<id>/events                                       # SSE stream (resumes with Last-Event-ID)
curl localhost:8787/runs/<id>/topics|findings|sources|assumptions|scenarios|plan
curl -X POST localhost:8787/runs/<id>/assumptions/as_001 -d '{"value": 0.08}' # edit an assumption; scenarios and plan recompute
```

One process hosts one run (`POST /runs` answers 409 while one is live). Crash recovery: `resumeRun(runId)` in `src/orchestrator/run.ts` restores from `data/mozaik.db` (older `data/<run_id>.json` files still work). Needs Node 22+ (`better-sqlite3`).

- Design and Mozaik mapping: [`docs/MASTERPLAN.md`](docs/MASTERPLAN.md)
- Repo rules for every machine (read first): [`CLAUDE.md`](CLAUDE.md)
- Data contracts: [`contracts/`](contracts/README.md)
- Who is doing what: [`STATUS.md`](STATUS.md)

```bash
npm install
npm run check   # validate fixtures, typecheck, tests
```
