import type { LinearWorkflowState } from "./linear";

const STATE_TYPE_ORDER: Record<string, number> = { backlog: 0, triage: 1, unstarted: 2, started: 3, completed: 4, canceled: 5 };

/**
 * Resolve the configured end status to one that exists in the project's workflow.
 * Falls back to a "merged"-named started state, then any completed state.
 */
export function computeEffectiveEndStatus(endStatusName: string, states: LinearWorkflowState[]): string {
  const candidates = states.filter((s) => s.type === "started" || s.type === "completed");
  if (endStatusName && candidates.some((s) => s.name === endStatusName)) return endStatusName;
  const merged = candidates.find((s) => s.type === "started" && s.name.toLowerCase().includes("merged"));
  if (merged) return merged.name;
  const completed = candidates.find((s) => s.type === "completed");
  return completed ? completed.name : "";
}

export function sortStates(states: LinearWorkflowState[]): LinearWorkflowState[] {
  return [...states].sort((a, b) => {
    const ta = STATE_TYPE_ORDER[a.type] ?? 9;
    const tb = STATE_TYPE_ORDER[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    return a.position - b.position;
  });
}

export function getStateProgress(state: LinearWorkflowState, allStartedStates: LinearWorkflowState[]): number {
  if (state.type === "completed") return 1;
  if (state.type === "canceled") return 0;
  if (state.type !== "started" || allStartedStates.length === 0) return 0;
  const idx = allStartedStates.findIndex((s) => s.id === state.id);
  if (idx < 0) return 0.5;
  return (idx + 1) / (allStartedStates.length + 1);
}
