# How to run the demo

A scripted ~90-second demo of Strategy Swarm. It needs **no API keys** and no real research run: a mock server plays a prepared run and the page drives itself, so the presenter only talks. Figures are illustrative (Demo Logistics d.o.o.), not output of the real analysis engine.

## Requirements
- Node 22+ and npm
- A browser (Chrome recommended); a laptop or projector at 1280 px width or wider

## Steps

```bash
git clone https://github.com/Vulpes107/vds-mozaik-jigjoy-2026.git
cd vds-mozaik-jigjoy-2026
git checkout d/scripted-demo      # skip once this branch is merged into main
cd dashboard
npm install
```

Open two terminals in `dashboard/`.

**Terminal 1: the scripted API**
```bash
MOCK_DEMO=1 npm run mock          # listens on http://localhost:8787
```

**Terminal 2: the page**
```bash
npm run dev                       # http://localhost:5173
```

Then open **http://localhost:5173/?auto=1** and start talking. Nothing else to click.

## What happens (seconds after the page presses Approve)

| Time | On screen |
|---|---|
| before 0 | Form filled with recommended values, "Start run", then the Approve banner |
| 0 to 20 | "The agents at work": workers get topics; a topic is dropped (~9 s) and its agent is reassigned |
| 20 to 32 | "How well do we know it?", then back to agents while the analysis runs |
| ~30 | Plan appears; page jumps to the verdict (liquidity warning first) |
| 40 to 54 | Recommendations, "Why this?" opened |
| 58 to 70 | "Can we afford it?": the price slider drops below ~45 EUR and the verdict flips from Expand to Continue |
| 72 to 90 | Risks, evidence, back to the top |

The speaker script with the matching lines is in `docs/DEMO.md`.

## Replay and reset
- Reload `http://localhost:5173/?auto=1`: the page presses "Start run" again and the script restarts from zero.
- If anything looks stuck, stop the mock (Ctrl+C), start it again, reload.
- Without `?auto=1` you get the manual version: press "Start run", "Approve" and drag the slider yourself.

## Options
| Variable | Effect |
|---|---|
| `MOCK_DEMO=1` | the scripted 90 s run (required for the demo) |
| `DEMO_SPEED=30` | play the script faster (used by the automated check) |
| `PORT=8788` | mock server port; then start the page with `API_URL=http://localhost:8788 npm run dev` |

## Troubleshooting
- **Page shows HTML or JSON errors:** Vite started before the mock; restart `npm run dev`.
- **Port in use:** `pkill -f mock-server/server.mjs` and `pkill -f "vite"`, then start again.
- **Page does nothing at `?auto=1`:** the autopilot flag lives in `sessionStorage`; open the URL in a fresh tab.
- **Automated check without a browser:** `node e2e/demo-mode.mjs` runs the whole script at 30x and verifies each beat.
