// Per-project user preferences persisted to localStorage.

const GLOBAL_STORAGE_KEY = "linear-planner";

export type Mode = "workers" | "tree" | "treeGlobal";

export interface ProjectSettings {
  numWorkers: number;
  mode: Mode;
  /** When mode === "tree", whether to draw arrows for blockers across milestones. */
  drawCrossMilestoneDeps: boolean;
  /** Whether the per-milestone tree view includes done issues. */
  includeDoneIssuesTree: boolean;
  /** Whether the global tree view includes done issues. */
  includeDoneIssuesTreeGlobal: boolean;
  showWeekends: boolean;
  showHolidays: boolean;
  showCooldown: boolean;
  startStatusName: string;
  endStatusName: string;
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  numWorkers: 2,
  mode: "workers",
  drawCrossMilestoneDeps: false,
  includeDoneIssuesTree: true,
  includeDoneIssuesTreeGlobal: true,
  showWeekends: false,
  showHolidays: true,
  showCooldown: true,
  startStatusName: "",
  endStatusName: "",
};

export function loadProjectSettings(projectId: string): ProjectSettings {
  try {
    const raw = localStorage.getItem(`${GLOBAL_STORAGE_KEY}:${projectId}`);
    if (!raw) return DEFAULT_PROJECT_SETTINGS;
    const data = JSON.parse(raw);
    // Migration: old "treeIndividual" → "tree" with cross-milestone deps off
    let mode: Mode = "workers";
    let drawCrossMilestoneDeps = false;
    if (data.mode === "tree") { mode = "tree"; drawCrossMilestoneDeps = data.drawCrossMilestoneDeps ?? true; }
    else if (data.mode === "treeIndividual") { mode = "tree"; drawCrossMilestoneDeps = false; }
    else if (data.mode === "treeGlobal") { mode = "treeGlobal"; }
    // Migration: a single `includeDoneIssues` value (older shape) is copied to both per-view flags.
    const legacyIncludeDone = data.includeDoneIssues;
    return {
      numWorkers: typeof data.numWorkers === "number" && data.numWorkers >= 1 ? data.numWorkers : 2,
      mode,
      drawCrossMilestoneDeps,
      includeDoneIssuesTree: data.includeDoneIssuesTree ?? legacyIncludeDone ?? true,
      includeDoneIssuesTreeGlobal: data.includeDoneIssuesTreeGlobal ?? legacyIncludeDone ?? true,
      showWeekends: data.showWeekends ?? false,
      showHolidays: data.showHolidays ?? true,
      showCooldown: data.showCooldown ?? true,
      startStatusName: typeof data.startStatusName === "string" ? data.startStatusName : "",
      endStatusName: typeof data.endStatusName === "string" ? data.endStatusName : "",
    };
  } catch {
    return DEFAULT_PROJECT_SETTINGS;
  }
}

export function saveProjectSettings(projectId: string, s: ProjectSettings) {
  localStorage.setItem(`${GLOBAL_STORAGE_KEY}:${projectId}`, JSON.stringify(s));
}

/** Legacy key — used pre-OAuth. Removed at startup to avoid stale state. */
export const LEGACY_STORAGE_KEY = GLOBAL_STORAGE_KEY;
