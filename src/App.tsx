import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { fetchProjects, fetchProjectIssues, fetchProjectCycles, fetchProjectMilestones, fetchProjectWorkflowStates, fetchIssueEndDates } from "./linear";
import type { LinearProject, LinearIssue, LinearCycle, LinearMilestone, LinearWorkflowState } from "./linear";
import { startLogin, handleOAuthCallback, getCallbackPath, isAuthenticated, clearTokens, logout } from "./auth";
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
    if (rest && rest !== "" && rest !== "callback") return rest;
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

  const endStatusNameRef = useRef(endStatusName);
  endStatusNameRef.current = endStatusName;

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

  // Restore session on mount (or handle OAuth callback)
  useEffect(() => {
    const callbackPath = getCallbackPath();
    const pathname = window.location.pathname;

    // Handle OAuth callback
    if (pathname === callbackPath || pathname === callbackPath + "/") {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const state = params.get("state");

      if (code && state) {
        handleOAuthCallback(code, state)
          .then(async () => {
            window.history.replaceState(null, "", BASE_PATH + "/");
            const projs = await fetchProjects();
            if (projs.length === 0) {
              clearTokens();
              setError("No projects found in your Linear workspace.");
              setRestoring(false);
              return;
            }
            setProjects(projs);
            setConnected(true);
            setRestoring(false);
          })
          .catch((e) => {
            window.history.replaceState(null, "", BASE_PATH + "/");
            setError(e instanceof Error ? e.message : "OAuth authentication failed");
            setRestoring(false);
          });
        return;
      }

      // No code/state in callback URL, redirect to main
      window.history.replaceState(null, "", BASE_PATH + "/");
    }

    // Normal session restoration from stored tokens
    if (!isAuthenticated()) {
      // Clean up legacy API key storage
      localStorage.removeItem(GLOBAL_STORAGE_KEY);
      setRestoring(false);
      return;
    }

    (async () => {
      try {
        const projs = await fetchProjects();
        if (projs.length === 0) {
          clearTokens();
          setRestoring(false);
          return;
        }
        setProjects(projs);

        const urlProjectId = getProjectIdFromUrl();
        const match = urlProjectId ? projs.find((p) => p.id === urlProjectId) : null;
        const pid = match ? urlProjectId! : "";

        if (pid) {
          const ps = loadProjectSettings(pid);
          setNumWorkers(ps.numWorkers);
          setMode(ps.mode);
          setShowWeekends(ps.showWeekends);
          setShowHolidays(ps.showHolidays);
          setShowCooldown(ps.showCooldown);
          setStartStatusName(ps.startStatusName);
          setEndStatusName(ps.endStatusName);
        }

        setSelectedProjectId(pid);
        setConnected(true);
      } catch {
        clearTokens();
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

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
        fetchProjectIssues(projectId),
        fetchProjectCycles(projectId),
        fetchProjectMilestones(projectId),
        fetchProjectWorkflowStates(projectId),
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
        ? await fetchIssueEndDates(doneIds, endName)
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

  const handleDisconnect = useCallback(async () => {
    await logout();
    setConnected(false);
    setProjectIssues([]);
    setProjectCycles([]);
    setProjectMilestones([]);
    setWorkflowStates([]);
    setProjects([]);
    setSelectedProjectId("");
    navigateToProject(null);
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--border)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Linear planner</h1>
          {connected && (
            <button
              onClick={handleDisconnect}
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
                {!selectedProjectId && <option value="">Select a project…</option>}
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
              Sign in with your Linear account to get started.<br />
              <span style={{ fontSize: 12, display: "block", marginTop: 4 }}>Read-only access to your workspace projects.</span>
            </p>
            {error && <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 16 }}>{error}</p>}
            <button
              onClick={() => { setError(null); startLogin(); }}
              style={{ ...buttonStyle, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              <svg width="16" height="16" viewBox="0 0 100 100" fill="none">
                <path d="M1.22541 61.5228c-.97395-3.1498-.6726-6.5664.82382-9.3819l17.82677 17.8268c-2.8156 1.4964-6.2321 1.7977-9.38189.8238L1.22541 61.5228Z" fill="currentColor"/>
                <path d="M3.03935 45.6498c.29957-.6032.63498-1.1903 1.0047-1.7577l49.8638 49.8637c-.5674.3698-1.1545.7052-1.7577 1.0048L3.03935 45.6498Z" fill="currentColor"/>
                <path d="M7.71875 38.3755c.51463-.6698 1.07064-1.307 1.66479-1.9081l52.14936 52.1494c-.6012.5942-1.2384 1.1502-1.9082 1.6648L7.71875 38.3755Z" fill="currentColor"/>
                <path d="M14.3344 32.1498c.5765-.5765 1.1812-1.1194 1.8108-1.6264l53.331 53.331c-.507.6296-1.0499 1.2344-1.6264 1.8108L14.3344 32.1498Z" fill="currentColor"/>
                <path d="M22.0669 26.7382c.6647-.5095 1.3576-.9811 2.0751-1.4118l50.5321 50.5321c-.4307.7175-.9023 1.4104-1.4118 2.0751L22.0669 26.7382Z" fill="currentColor"/>
                <path d="M31.0358 22.3528c.7702-.3626 1.5611-.6744 2.3687-.9339l44.177 44.1769c-.2595.8077-.5713 1.5986-.9339 2.3688L31.0358 22.3528Z" fill="currentColor"/>
                <path d="M41.7183 19.6735c.8579-.1524 1.725-.2389 2.5963-.2579l36.2699 36.2699c-.019.8714-.1055 1.7384-.258 2.5963L41.7183 19.6735Z" fill="currentColor"/>
                <path d="M54.0545 20.4375 79.5624 45.9454c-.6594 2.7717-2.1184 5.2884-4.2147 7.227L47.6279 25.4526c1.3523-1.4602 2.9964-2.6353 4.8128-3.4401 .5261-.2244 1.0631-.4188 1.6138-.5751Z" fill="currentColor"/>
                <path d="M63.4891 22.2024 77.7977 36.511c-1.0986 2.3186-2.8345 4.2871-5.0152 5.6801L58.7073 28.1159c1.0399-.7622 1.9596-1.6826 2.7218-2.7225.6784-.9264 1.2288-1.9421 1.6356-3.0255l.4244-.1655Z" fill="currentColor"/>
                <path d="M69.7925 25.6586 74.5088 30.375c-.3041.9476-.7466 1.8445-1.313 2.6624l-6.0663-6.0663c.8179-.5664 1.7148-1.0088 2.6624-1.313l.0006.0005Z" fill="currentColor"/>
              </svg>
              Sign in with Linear
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
const headerInputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 13, outline: "none" };
const tabButtonStyle: React.CSSProperties = { padding: "8px 20px", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const stepperButtonStyle: React.CSSProperties = { padding: "4px 10px", border: "none", background: "var(--surface-hover)", color: "var(--text)", fontSize: 14, fontWeight: 600, cursor: "pointer", lineHeight: 1 };
const buttonStyle: React.CSSProperties = { padding: "10px 20px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" };
