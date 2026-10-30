// Public entry for Machine C. Wire it in the app entry point after startRuntime():
//
//   const session = new AnalysisSession(state)
//   registerAnalysis(session)
//   // later, once research is done:
//   sendEvent(SemanticEvent.create(EV.AnalysisRequested, someJoinedParticipantId, {}), someJoinedParticipantId)
export { AnalysisSession } from "./session.ts"
export { registerAnalysis, type AnalysisOptions } from "./participants.ts"
export { createAnalysisTools } from "./tools.ts"
export { assertValid, isValid } from "./contracts.ts"
export { assemblePlan, DISCLAIMER } from "./engine/plan.ts"
export { computeScenario } from "./engine/scenario.ts"
export { computeTco } from "./engine/tco.ts"
export { tornado, rankAssumptions, breakEvenValue } from "./engine/sensitivity.ts"
