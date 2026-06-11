import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { fetchProjects, fetchProjectIssues, fetchProjectCycles, fetchProjectMilestones, fetchProjectWorkflowStates, fetchIssueEndDates, createBlockingRelation, deleteIssueRelation } from "./linear";
import type { LinearProject, LinearIssue, LinearCycle, LinearMilestone, LinearWorkflowState } from "./linear";
import { startLogin, handleOAuthCallback, getCallbackPath, isAuthenticated, clearTokens, logout, isWriteEnabled, setWriteEnabled } from "./auth";
import { scheduleIssues } from "./scheduler";
import type { ScheduleResult } from "./scheduler";
import { GanttChart } from "./GanttChart";
import { DependencyTree } from "./DependencyTree";
import { BASE_PATH, getProjectIdFromUrl, navigateToProject } from "./routing";
import { loadProjectSettings, saveProjectSettings, LEGACY_STORAGE_KEY, type Mode } from "./projectSettings";
import { computeEffectiveEndStatus, sortStates } from "./workflowState";
import { StatusSelect } from "./StatusSelect";
import { centerCard, headerInputStyle, tabButtonStyle, stepperButtonStyle, buttonStyle } from "./appStyles";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [projects, setProjects] = useState<LinearProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [numWorkers, setNumWorkers] = useState(2);
  const [mode, setMode] = useState<Mode>("workers");
  const [showWeekends, setShowWeekends] = useState(false);
  const [showHolidays, setShowHolidays] = useState(true);
  const [showCooldown, setShowCooldown] = useState(true);
  const [drawCrossMilestoneDeps, setDrawCrossMilestoneDeps] = useState(false);
  const [includeDoneIssuesTree, setIncludeDoneIssuesTree] = useState(true);
  const [includeDoneIssuesTreeGlobal, setIncludeDoneIssuesTreeGlobal] = useState(true);
  const [startStatusName, setStartStatusName] = useState("");
  const [endStatusName, setEndStatusName] = useState("");
  const [doneEndDates, setDoneEndDates] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [writeEnabled, setWriteEnabledState] = useState(isWriteEnabled());

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
    const unlimited = scheduleIssues(projectIssues, projectIssues.length, chartStart, projectCycles, projectMilestones, workflowStates, effectiveEndStatus, doneEndDates, effectiveStartStatus);
    return unlimited.usedWorkers;
  }, [projectIssues, projectCycles, projectMilestones, workflowStates, chartStart, effectiveEndStatus, doneEndDates, effectiveStartStatus]);

  const effectiveWorkers = Math.min(numWorkers, maxParallelism);

  const schedule: ScheduleResult | null = useMemo(() => {
    if (projectIssues.length === 0) return null;
    return scheduleIssues(projectIssues, effectiveWorkers, chartStart, projectCycles, projectMilestones, workflowStates, effectiveEndStatus, doneEndDates, effectiveStartStatus);
  }, [projectIssues, projectCycles, projectMilestones, workflowStates, effectiveWorkers, chartStart, effectiveEndStatus, doneEndDates, effectiveStartStatus]);

  // Restore session on mount (or handle OAuth callback)
  useEffect(() => {
    const callbackPath = getCallbackPath();
    const pathname = window.location.pathname;

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

      window.history.replaceState(null, "", BASE_PATH + "/");
    }

    if (!isAuthenticated()) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
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
          setDrawCrossMilestoneDeps(ps.drawCrossMilestoneDeps);
          setIncludeDoneIssuesTree(ps.includeDoneIssuesTree);
          setIncludeDoneIssuesTreeGlobal(ps.includeDoneIssuesTreeGlobal);
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

  useEffect(() => {
    if (connected && selectedProjectId) {
      saveProjectSettings(selectedProjectId, { numWorkers, mode, drawCrossMilestoneDeps, includeDoneIssuesTree, includeDoneIssuesTreeGlobal, showWeekends, showHolidays, showCooldown, startStatusName, endStatusName });
    }
  }, [connected, selectedProjectId, numWorkers, mode, drawCrossMilestoneDeps, includeDoneIssuesTree, includeDoneIssuesTreeGlobal, showWeekends, showHolidays, showCooldown, startStatusName, endStatusName]);

  useEffect(() => {
    if (connected && selectedProjectId) {
      navigateToProject(selectedProjectId);
    }
  }, [connected, selectedProjectId]);

  useEffect(() => {
    const handler = () => {
      const pid = getProjectIdFromUrl();
      if (pid && pid !== selectedProjectId && projects.some((p) => p.id === pid)) {
        const ps = loadProjectSettings(pid);
        setNumWorkers(ps.numWorkers);
        setMode(ps.mode);
        setDrawCrossMilestoneDeps(ps.drawCrossMilestoneDeps);
        setIncludeDoneIssuesTree(ps.includeDoneIssuesTree);
        setIncludeDoneIssuesTreeGlobal(ps.includeDoneIssuesTreeGlobal);
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

  const handleProjectChange = useCallback((projectId: string) => {
    const ps = loadProjectSettings(projectId);
    setNumWorkers(ps.numWorkers);
    setMode(ps.mode);
    setDrawCrossMilestoneDeps(ps.drawCrossMilestoneDeps);
    setIncludeDoneIssuesTree(ps.includeDoneIssuesTree);
    setIncludeDoneIssuesTreeGlobal(ps.includeDoneIssuesTreeGlobal);
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

  const handleToggleWriteEnabled = useCallback(async (next: boolean) => {
    if (next === writeEnabled) return;
    const msg = next
      ? "Enable write access? You'll be redirected to Linear to re-authorize with read+write scope."
      : "Switch back to read-only? You'll be redirected to Linear to re-authorize.";
    if (!window.confirm(msg)) return;
    setWriteEnabled(next);
    setWriteEnabledState(next);
    await logout();
    startLogin();
  }, [writeEnabled]);

  const handleCreateBlockingRelation = useCallback(async (blockerId: string, blockedId: string) => {
    await createBlockingRelation(blockerId, blockedId);
    // Refetch issues so the new relation shows up in the schedule and tree.
    if (selectedProjectId) await loadProject(selectedProjectId);
  }, [selectedProjectId, loadProject]);

  const handleDeleteRelation = useCallback(async (relationId: string) => {
    await deleteIssueRelation(relationId);
    if (selectedProjectId) await loadProject(selectedProjectId);
  }, [selectedProjectId, loadProject]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--border)", background: "var(--surface)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Linear planner</h1>
          {connected && (
            <>
              <label
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", cursor: "pointer", marginLeft: "auto" }}
                title="Allow drag-and-drop dependency edits (requires Linear write scope)"
              >
                <input
                  type="checkbox"
                  checked={writeEnabled}
                  onChange={(e) => handleToggleWriteEnabled(e.target.checked)}
                />
                Allow writes
              </label>
              <button
                onClick={handleDisconnect}
                style={{ ...buttonStyle, background: "transparent", color: "var(--text-muted)", padding: "4px 12px", fontSize: 12 }}
              >
                Disconnect
              </button>
            </>
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
                  Tree (per milestone)
                </button>
                <button onClick={() => setMode("treeGlobal")} style={{ ...tabButtonStyle, background: mode === "treeGlobal" ? "var(--accent)" : "var(--bg)", color: mode === "treeGlobal" ? "#fff" : "var(--text-muted)" }}>
                  Tree (global)
                </button>
              </div>
              {(mode === "tree" || mode === "treeGlobal") && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={mode === "tree" ? includeDoneIssuesTree : includeDoneIssuesTreeGlobal}
                    onChange={(e) => {
                      if (mode === "tree") setIncludeDoneIssuesTree(e.target.checked);
                      else setIncludeDoneIssuesTreeGlobal(e.target.checked);
                    }}
                  />
                  Include done issues
                </label>
              )}
              {mode === "tree" && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
                  <input type="checkbox" checked={drawCrossMilestoneDeps} onChange={(e) => setDrawCrossMilestoneDeps(e.target.checked)} />
                  Draw dependencies between milestones
                </label>
              )}
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
              <DependencyTree schedule={schedule} variant={drawCrossMilestoneDeps ? "split" : "individual"} includeDone={includeDoneIssuesTree} writeEnabled={writeEnabled} onCreateBlockingRelation={handleCreateBlockingRelation} onDeleteRelation={handleDeleteRelation} />
            )}
            {!loading && !error && schedule && mode === "treeGlobal" && (
              <DependencyTree schedule={schedule} variant="global" includeDone={includeDoneIssuesTreeGlobal} writeEnabled={writeEnabled} onCreateBlockingRelation={handleCreateBlockingRelation} onDeleteRelation={handleDeleteRelation} />
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
