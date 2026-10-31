import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		host: true, // all interfaces: under WSL2 the Windows browser may not reach a 127.0.0.1-only listener
		// Same-origin API: no CORS preflight against the orchestrator (or mock) on :8787.
		proxy: { "/runs": process.env.API_URL ?? "http://localhost:8787" },
		fs: { allow: [".."] }, // the intake form is prefilled from ../mocks
	},
})
