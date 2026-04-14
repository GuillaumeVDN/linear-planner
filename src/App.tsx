import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { fetchProjects, fetchProjectIssues, fetchProjectCycles, fetchProjectMilestones, fetchProjectWorkflowStates, fetchIssueEndDates } from "./linear";
import type { LinearProject, LinearIssue, LinearCycle, LinearMilestone, LinearWorkflowState } from "./linear";
import { scheduleIssues } from "./scheduler";
import type { ScheduleResult } from "./scheduler";
import { GanttChart } from "./GanttChart";
import { DependencyTree } from "./DependencyTree";
import { StatusCircle } from "./StatusCircle";

// --- Routing helpers ---
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, ""); // e.g. "/linear-planner"

function getProjectIdFromUrl(): string | null {
  const path = window.location.pathname;
  const prefix = BASE_PATH + "/";
  if (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length).replace(/\/$/, "");
    if (rest && rest !== "") return rest;
  }
  return null;
}

function navigateToProject(projectId: string | null) {
  const url = projectId ? `${BASE_PATH}/${projectId}/` : `${BASE_PATH}/`;
  window.history.pushState(null, "", url);
}

// --- Per-project storage ---
const GLOBAL_STORAGE_KEY = "linear-planner";

type Mode = "workers" | "tree";

interface GlobalSettings {
  apiKey: string;
}

interface ProjectSettings {
  numWorkers: number;
  mode: Mode;
  showWeekends: boolean;
  showHolidays: boolean;
  showCooldown: boolean;
  startStatusName: string;
  endStatusName: string;
}

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  numWorkers: 2,
  mode: "workers",
  showWeekends: false,
  showHolidays: true,
  showCooldown: true,
  startStatusName: "",
  endStatusName: "",
};

function loadGlobalSettings(): GlobalSettings | null {
  try {
    const raw = localStorage.getItem(GLOBAL_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.apiKey !== "string" || !data.apiKey) return null;
    return { apiKey: data.apiKey };
  } catch {
    return null;
  }
}

function saveGlobalSettings(s: GlobalSettings) {
  localStorage.setItem(GLOBAL_STORAGE_KEY, JSON.stringify(s));
}

function clearGlobalSettings() {
  localStorage.removeItem(GLOBAL_STORAGE_KEY);
}

function loadProjectSettings(projectId: string): ProjectSettings {
  try {
    const raw = localStorage.getItem(`${GLOBAL_STORAGE_KEY}:${projectId}`);
    if (!raw) return DEFAULT_PROJECT_SETTINGS;
    const data = JSON.parse(raw);
    return {
      numWorkers: typeof data.numWorkers === "number" && data.numWorkers >= 1 ? data.numWorkers : 2,
      mode: data.mode === "tree" ? "tree" : "workers",
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

function saveProjectSettings(projectId: string, s: ProjectSettings) {
  localStorage.setItem(`${GLOBAL_STORAGE_KEY}:${projectId}`, JSON.stringify(s));
}

// --- Workflow state helpers ---

const STATE_TYPE_ORDER: Record<string, number> = { backlog: 0, triage: 1, unstarted: 2, started: 3, completed: 4, canceled: 5 };

function computeEffectiveEndStatus(endStatusName: string, states: LinearWorkflowState[]): string {
  const candidates = states.filter((s) => s.type === "started" || s.type === "completed");
  if (endStatusName && candidates.some((s) => s.name === endStatusName)) return endStatusName;
  const merged = candidates.find((s) => s.type === "started" && s.name.toLowerCase().includes("merged"));
  if (merged) return merged.name;
  const completed = candidates.find((s) => s.type === "completed");
  return completed ? completed.name : "";
}

function sortStates(states: LinearWorkflowState[]): LinearWorkflowState[] {
  return [...states].sort((a, b) => {
    const ta = STATE_TYPE_ORDER[a.type] ?? 9;
    const tb = STATE_TYPE_ORDER[b.type] ?? 9;
    if (ta !== tb) return ta - tb;
    return a.position - b.position;
  });
}

function getStateProgress(state: LinearWorkflowState, allStartedStates: LinearWorkflowState[]): number {
  if (state.type === "completed") return 1;
  if (state.type === "canceled") return 0;
  if (state.type !== "started" || allStartedStates.length === 0) return 0;
  const idx = allStartedStates.findIndex((s) => s.id === state.id);
  if (idx < 0) return 0.5;
  return (idx + 1) / (allStartedStates.length + 1);
}

function StatusSelect({ states, startedStates, value, onChange }: {
  states: LinearWorkflowState[];
  startedStates: LinearWorkflowState[];
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = states.find((s) => s.name === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ ...headerInputStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", background: "var(--bg)", minWidth: 120 }}
      >
        {selected && <StatusCircle stateType={selected.type} color={selected.color} progress={getStateProgress(selected, startedStates)} size={12} />}
        <span style={{ flex: 1, textAlign: "left" }}>{selected?.name ?? value}</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 2, zIndex: 100,
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)", minWidth: "100%", maxHeight: 260, overflowY: "auto",
        }}>
          {states.map((s) => (
            <button
              key={s.id}
              onClick={() => { onChange(s.name); setOpen(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 10px",
                border: "none", background: s.name === value ? "var(--surface-hover)" : "transparent",
                color: "var(--text)", fontSize: 13, cursor: "pointer", textAlign: "left",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = s.name === value ? "var(--surface-hover)" : "transparent"; }}
            >
              <StatusCircle stateType={s.type} color={s.color} progress={getStateProgress(s, startedStates)} size={12} />
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- App ---

export default function App() {
  const [connected, setConnected] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [projects, setProjects] = useState<LinearProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [numWorkers, setNumWorkers] = useState(2);
  const [mode, setMode] = useState<Mode>("workers");
  const [showWeekends, setShowWeekends] = useState(false);
  const [showHolidays, setShowHolidays] = useState(true);
  const [showCooldown, setShowCooldown] = useState(true);
  const [startStatusName, setStartStatusName] = useState("");
  const [endStatusName, setEndStatusName] = useState("");
  const [doneEndDates, setDoneEndDates] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);

  const [projectIssues, setProjectIssues] = useState<LinearIssue[]>([]);
  const [projectCycles, setProjectCycles] = useState<LinearCycle[]>([]);
  const [projectMilestones, setProjectMilestones] = useState<LinearMilestone[]>([]);
  const [workflowStates, setWorkflowStates] = useState<LinearWorkflowState[]>([]);
  const [chartStart, setChartStart] = useState<Date>(new Date());

  const apiKeyRef = useRef(apiKey);
  const endStatusNameRef = useRef(endStatusName);
  endStatusNameRef.current = endStatusName;
  apiKeyRef.current = apiKey;

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const startedStates = useMemo(
    () => sortStates(workflowStates.filter((s) => s.type === "started")),
    [workflowStates],
  );

  const endStatusCandidates = useMemo(
    () => sortStates(workflowStates.filter((s) => s.type === "started" || s.type === "completed")),
    [workflowStates],
  );

  const effectiveStartStatus = useMemo(() => {
    if (startStatusName && startedStates.some((s) => s.name === startStatusName)) return startStatusName;
    return startedStates.length > 0 ? startedStates[0].name : "";
  }, [startStatusName, startedStates]);

  const effectiveEndStatus = useMemo(
    () => computeEffectiveEndStatus(endStatusName, workflowStates),
    [endStatusName, workflowStates],
  );

  const maxParallelism = useMemo(() => {
    if (projectIssues.length === 0) return 1;
    const unlimited = scheduleIssues(projectIssues, projectIssues.length, chartStart, projectCycles, projectMilestones, workflowStates, effectiveEndStatus, doneEndDates);
    return unlimited.usedWorkers;
  }, [projectIssues, projectCycles, projectMilestones, workflowStates, chartStart, effectiveEndStatus, doneEndDates]);

  const effectiveWorkers = Math.min(numWorkers, maxParallelism);

  const schedule: ScheduleResult | null = useMemo(() => {
    if (projectIssues.length === 0) return null;
    return scheduleIssues(projectIssues, effectiveWorkers, chartStart, projectCycles, projectMilestones, workflowStates, effectiveEndStatus, doneEndDates);
  }, [projectIssues, projectCycles, projectMilestones, workflowStates, effectiveWorkers, chartStart, effectiveEndStatus, doneEndDates]);

  // Restore session on mount
  useEffect(() => {
    const global = loadGlobalSettings();
    if (!global) {
      setRestoring(false);
      return;
    }
    (async () => {
      try {
        const projs = await fetchProjects(global.apiKey);
        if (projs.length === 0) {
          clearGlobalSettings();
          setRestoring(false);
          return;
        }
        setApiKey(global.apiKey);
        setProjects(projs);

        // Determine project from URL or pick first
        const urlProjectId = getProjectIdFromUrl();
        const match = urlProjectId ? projs.find((p) => p.id === urlProjectId) : null;
        const pid = match ? urlProjectId! : projs[0].id;

        // Load per-project settings
        const ps = loadProjectSettings(pid);
        setNumWorkers(ps.numWorkers);
        setMode(ps.mode);
        setShowWeekends(ps.showWeekends);
        setShowHolidays(ps.showHolidays);
        setShowCooldown(ps.showCooldown);
        setStartStatusName(ps.startStatusName);
        setEndStatusName(ps.endStatusName);

        setSelectedProjectId(pid);
        setConnected(true);
      } catch {
        clearGlobalSettings();
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  // Save global settings (API key)
  useEffect(() => {
    if (connected) saveGlobalSettings({ apiKey });
  }, [connected, apiKey]);

  // Save per-project settings when they change
  useEffect(() => {
    if (connected && selectedProjectId) {
      saveProjectSettings(selectedProjectId, { numWorkers, mode, showWeekends, showHolidays, showCooldown, startStatusName, endStatusName });
    }
  }, [connected, selectedProjectId, numWorkers, mode, showWeekends, showHolidays, showCooldown, startStatusName, endStatusName]);

  // Update URL when project changes
  useEffect(() => {
    if (connected && selectedProjectId) {
      navigateToProject(selectedProjectId);
    }
  }, [connected, selectedProjectId]);

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => {
      const pid = getProjectIdFromUrl();
      if (pid && pid !== selectedProjectId && projects.some((p) => p.id === pid)) {
        const ps = loadProjectSettings(pid);
        setNumWorkers(ps.numWorkers);
        setMode(ps.mode);
        setShowWeekends(ps.showWeekends);
        setShowHolidays(ps.showHolidays);
        setShowCooldown(ps.showCooldown);
        setStartStatusName(ps.startStatusName);
        setEndStatusName(ps.endStatusName);
        setSelectedProjectId(pid);
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [selectedProjectId, projects]);

  const handleConnect = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const projs = await fetchProjects(apiKey);
      if (projs.length === 0) {
        setError("No projects found in your Linear workspace.");
        return;
      }
      setProjects(projs);
      setSelectedProjectId(projs[0].id);
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect to Linear");
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  // When project changes, load per-project settings and fetch data
  const handleProjectChange = useCallback((projectId: string) => {
    const ps = loadProjectSettings(projectId);
    setNumWorkers(ps.numWorkers);
    setMode(ps.mode);
    setShowWeekends(ps.showWeekends);
    setShowHolidays(ps.showHolidays);
    setShowCooldown(ps.showCooldown);
    setStartStatusName(ps.startStatusName);
    setEndStatusName(ps.endStatusName);
    setSelectedProjectId(projectId);
  }, []);

  const loadProject = useCallback(async (projectId: string) => {
    if (!projectId) {
      setProjectIssues([]);
      setProjectCycles([]);
      setProjectMilestones([]);
      setWorkflowStates([]);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const [issues, cycles, milestones, states] = await Promise.all([
        fetchProjectIssues(apiKeyRef.current, projectId),
        fetchProjectCycles(apiKeyRef.current, projectId),
        fetchProjectMilestones(apiKeyRef.current, projectId),
        fetchProjectWorkflowStates(apiKeyRef.current, projectId),
      ]);
      setWorkflowStates(states);
      if (issues.length === 0) {
        setProjectIssues([]);
        setProjectCycles([]);
        setProjectMilestones([]);
        setError("No issues found in this project.");
        setLoading(false);
        return;
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let start = today;
      for (const issue of issues) {
        if (issue.startedAt) {
          const d = new Date(issue.startedAt);
          d.setHours(0, 0, 0, 0);
          if (d < start) start = d;
        }
      }
      // Fetch end dates for done issues from state history
      const endName = computeEffectiveEndStatus(endStatusNameRef.current, states);
      let endPosition: number | null = null;
      for (const s of states) {
        if (s.type === "started" && s.name === endName) {
          if (endPosition === null || s.position < endPosition) endPosition = s.position;
        }
      }
      const doneIds = issues.filter((i) => {
        if (!i.startedAt) return false;
        const t = i.state.type;
        if (t === "completed" || t === "canceled") return true;
        if (t === "started" && endPosition !== null && i.state.position >= endPosition) return true;
        return false;
      }).map((i) => i.id);

      const endDates = doneIds.length > 0
        ? await fetchIssueEndDates(apiKeyRef.current, doneIds, endName)
        : new Map<string, string>();

      setDoneEndDates(endDates);
      setProjectIssues(issues);
      setProjectCycles(cycles);
      setProjectMilestones(milestones);
      setChartStart(start);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch issues");
    } finally {
      setLoading(false);
    }
  }, []);

  const prevProjectId = useRef("");
  useEffect(() => {
    if (!connected) return;
    if (selectedProjectId !== prevProjectId.current) {
      prevProjectId.current = selectedProjectId;
      loadProject(selectedProjectId);
    }
  }, [connected, selectedProjectId, loadProject]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--border)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Linear planner</h1>
          {connected && (
            <button
              onClick={() => {
                clearGlobalSettings();
                setConnected(false);
                setProjectIssues([]);
                setProjectCycles([]);
                setProjectMilestones([]);
                setWorkflowStates([]);
                setProjects([]);
                setApiKey("");
                setSelectedProjectId("");
                navigateToProject(null);
              }}
              style={{ ...buttonStyle, background: "transparent", color: "var(--text-muted)", padding: "4px 12px", fontSize: 12, marginLeft: "auto" }}
            >
              Disconnect
            </button>
          )}
        </div>

        {connected && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <select value={selectedProjectId} onChange={(e) => handleProjectChange(e.target.value)} style={headerInputStyle}>
                {sortedProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {schedule && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{schedule.issues.length} issues</span>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-muted)" }}>
              Number of people working in parallel
              <div style={{ display: "flex", alignItems: "center", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
                <button onClick={() => setNumWorkers((n) => Math.max(1, n - 1))} disabled={numWorkers <= 1} style={stepperButtonStyle}>-</button>
                <span style={{ padding: "4px 12px", fontSize: 13, fontWeight: 600, minWidth: 32, textAlign: "center", background: "var(--bg)", color: "var(--text)" }}>
                  {Math.min(numWorkers, maxParallelism)}
                </span>
                <button onClick={() => setNumWorkers((n) => Math.min(maxParallelism, n + 1))} disabled={numWorkers >= maxParallelism} style={stepperButtonStyle}>+</button>
              </div>
            </div>

            {startedStates.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--text-muted)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  Start status
                  <StatusSelect states={startedStates} startedStates={startedStates} value={effectiveStartStatus} onChange={setStartStatusName} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  End status
                  <StatusSelect states={endStatusCandidates} startedStates={startedStates} value={effectiveEndStatus} onChange={setEndStatusName} />
                </div>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                <button onClick={() => setMode("workers")} style={{ ...tabButtonStyle, background: mode === "workers" ? "var(--accent)" : "var(--bg)", color: mode === "workers" ? "#fff" : "var(--text-muted)" }}>
                  Timeline
                </button>
                <button onClick={() => setMode("tree")} style={{ ...tabButtonStyle, background: mode === "tree" ? "var(--accent)" : "var(--bg)", color: mode === "tree" ? "#fff" : "var(--text-muted)" }}>
                  Dependency tree
                </button>
              </div>
            </div>
          </>
        )}
      </header>

      <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {restoring && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "var(--text-muted)" }}>Restoring session...</div>
        )}
        {!restoring && !connected && (
          <div style={centerCard}>
            <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Connect to Linear</h2>
            <p style={{ color: "var(--text-muted)", marginBottom: 24, fontSize: 14 }}>
              Enter your Linear API key to get started.<br />
              <a href="https://linear.app/dashdoc/settings/account/security/api-keys/new" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "var(--accent-hover)" }}>
                Create a new API key
              </a>
              <span style={{ fontSize: 12, display: "block", marginTop: 4 }}>Make it read-only and scoped to the relevant teams only.</span>
            </p>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="lin_api_..." onKeyDown={(e) => e.key === "Enter" && apiKey && handleConnect()} style={inputStyle} />
            {error && <p style={{ color: "#ef4444", fontSize: 13, marginTop: 8 }}>{error}</p>}
            <button onClick={handleConnect} disabled={!apiKey || loading} style={{ ...buttonStyle, marginTop: 16, width: "100%" }}>
              {loading ? "Connecting..." : "Connect"}
            </button>
          </div>
        )}

        {connected && (
          <div style={{ padding: 16, overflow: "auto" }}>
            {loading && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 64, color: "var(--text-muted)" }}>Loading issues...</div>
            )}
            {error && !loading && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 64, color: "#ef4444", fontSize: 14 }}>{error}</div>
            )}
            {!loading && !error && schedule && mode === "workers" && (
              <GanttChart schedule={schedule} showWeekends={showWeekends} showHolidays={showHolidays} showCooldown={showCooldown} setShowWeekends={setShowWeekends} setShowHolidays={setShowHolidays} setShowCooldown={setShowCooldown} />
            )}
            {!loading && !error && schedule && mode === "tree" && (
              <DependencyTree schedule={schedule} />
            )}
            {!loading && !error && !schedule && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 64, color: "var(--text-muted)" }}>Select a project to display.</div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

const centerCard: React.CSSProperties = { maxWidth: 420, width: "100%", margin: "auto", padding: 32, background: "var(--surface)", borderRadius: 12, border: "1px solid var(--border)" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 14, outline: "none" };
const headerInputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" };
const tabButtonStyle: React.CSSProperties = { padding: "8px 20px", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const stepperButtonStyle: React.CSSProperties = { padding: "4px 10px", border: "none", background: "var(--surface-hover)", color: "var(--text)", fontSize: 14, fontWeight: 600, cursor: "pointer", lineHeight: 1 };
const buttonStyle: React.CSSProperties = { padding: "10px 20px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" };
