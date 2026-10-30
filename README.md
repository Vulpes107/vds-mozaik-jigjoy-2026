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

- Design and Mozaik mapping: [`docs/MASTERPLAN.md`](docs/MASTERPLAN.md)
- Repo rules for every machine (read first): [`CLAUDE.md`](CLAUDE.md)
- Data contracts: [`contracts/`](contracts/README.md)
- Who is doing what: [`STATUS.md`](STATUS.md)

```bash
npm install
npm run check   # validate fixtures, typecheck, tests
```
