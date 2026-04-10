import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { fetchProjects, fetchProjectIssues, fetchProjectCycles, fetchProjectMilestones, fetchProjectWorkflowStates } from "./linear";
import type { LinearProject, LinearIssue, LinearCycle, LinearMilestone, LinearWorkflowState } from "./linear";
import { scheduleIssues } from "./scheduler";
import type { ScheduleResult } from "./scheduler";
import { GanttChart } from "./GanttChart";
import { DependencyTree } from "./DependencyTree";

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
}

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  numWorkers: 2,
  mode: "workers",
  showWeekends: false,
  showHolidays: true,
  showCooldown: true,
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
    };
  } catch {
    return DEFAULT_PROJECT_SETTINGS;
  }
}

function saveProjectSettings(projectId: string, s: ProjectSettings) {
  localStorage.setItem(`${GLOBAL_STORAGE_KEY}:${projectId}`, JSON.stringify(s));
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);

  const [projectIssues, setProjectIssues] = useState<LinearIssue[]>([]);
  const [projectCycles, setProjectCycles] = useState<LinearCycle[]>([]);
  const [projectMilestones, setProjectMilestones] = useState<LinearMilestone[]>([]);
  const [workflowStates, setWorkflowStates] = useState<LinearWorkflowState[]>([]);
  const [chartStart, setChartStart] = useState<Date>(new Date());

  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const maxParallelism = useMemo(() => {
    if (projectIssues.length === 0) return 1;
    const unlimited = scheduleIssues(projectIssues, projectIssues.length, chartStart, projectCycles, projectMilestones, workflowStates);
    return unlimited.usedWorkers;
  }, [projectIssues, projectCycles, projectMilestones, workflowStates, chartStart]);

  const effectiveWorkers = Math.min(numWorkers, maxParallelism);

  const schedule: ScheduleResult | null = useMemo(() => {
    if (projectIssues.length === 0) return null;
    return scheduleIssues(projectIssues, effectiveWorkers, chartStart, projectCycles, projectMilestones, workflowStates);
  }, [projectIssues, projectCycles, projectMilestones, workflowStates, effectiveWorkers, chartStart]);

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
      saveProjectSettings(selectedProjectId, { numWorkers, mode, showWeekends, showHolidays, showCooldown });
    }
  }, [connected, selectedProjectId, numWorkers, mode, showWeekends, showHolidays, showCooldown]);

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
      if (issues.length === 0) {
        setProjectIssues([]);
        setProjectCycles([]);
        setProjectMilestones([]);
        setWorkflowStates([]);
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
      setProjectIssues(issues);
      setProjectCycles(cycles);
      setProjectMilestones(milestones);
      setWorkflowStates(states);
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
