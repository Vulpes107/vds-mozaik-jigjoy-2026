import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { RUN_ID } from "./api.ts"
import { startAutopilot } from "./autopilot.ts"
import "./styles.css"

createRoot(document.getElementById("root")!).render(<App />)
startAutopilot(!!RUN_ID)
