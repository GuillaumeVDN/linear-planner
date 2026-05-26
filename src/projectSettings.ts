// Per-project user preferences persisted to localStorage.

const GLOBAL_STORAGE_KEY = "linear-planner";

export type Mode = "workers" | "tree" | "treeGlobal";

export interface ProjectSettings {
  numWorkers: number;
  mode: Mode;
  /** When mode === "tree", whether to draw arrows for blockers across milestones. */
  drawCrossMilestoneDeps: boolean;
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
    return {
      numWorkers: typeof data.numWorkers === "number" && data.numWorkers >= 1 ? data.numWorkers : 2,
      mode,
      drawCrossMilestoneDeps,
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
