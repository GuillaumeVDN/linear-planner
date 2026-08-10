import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LinearProject } from "./linear";
import { headerInputStyle } from "./appStyles";

interface TeamGroup {
  id: string;
  name: string;
  projects: LinearProject[];
}

/** Bucket for projects Linear reports with no team (rare, but they must stay reachable). */
const NO_TEAM_ID = "__no_team__";

/**
 * Group projects by team, both levels sorted alphabetically. A project belonging to
 * several teams is listed under each of them — same as in Linear.
 */
export function groupProjectsByTeam(projects: LinearProject[]): TeamGroup[] {
  const byTeam = new Map<string, TeamGroup>();
  for (const project of projects) {
    const teams = project.teams?.nodes ?? [];
    const entries = teams.length > 0 ? teams : [{ id: NO_TEAM_ID, name: "No team", key: "" }];
    for (const team of entries) {
      let group = byTeam.get(team.id);
      if (!group) {
        group = { id: team.id, name: team.name, projects: [] };
        byTeam.set(team.id, group);
      }
      group.projects.push(project);
    }
  }
  for (const group of byTeam.values()) {
    group.projects.sort((a, b) => a.name.localeCompare(b.name));
  }
  return Array.from(byTeam.values()).sort((a, b) => {
    // Keep the catch-all bucket at the bottom.
    if (a.id === NO_TEAM_ID) return 1;
    if (b.id === NO_TEAM_ID) return -1;
    return a.name.localeCompare(b.name);
  });
}

const PANEL_MAX_HEIGHT = 380;
const TEAM_PANE_WIDTH = 220;
const PROJECT_PANE_WIDTH = 320;

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 10px",
  border: "none",
  background: "transparent",
  color: "var(--text)",
  fontSize: 13,
  textAlign: "left",
  cursor: "pointer",
  borderRadius: 4,
  whiteSpace: "nowrap",
};

/**
 * Project picker rendered as a two-pane menu: teams on the left, the projects of the
 * highlighted team on the right. Replaces a flat <select>, which cannot nest submenus.
 *
 * The closed button sizes itself to the selected project name (via a hidden measuring
 * span) rather than to the longest one, keeping the header compact.
 */
export function ProjectSelect({
  projects,
  value,
  onChange,
  placeholder = "Select a project…",
  maxWidth = 360,
}: {
  projects: LinearProject[];
  value: string;
  onChange: (projectId: string) => void;
  placeholder?: string;
  maxWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [hoveredProjectId, setHoveredProjectId] = useState<string | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

  const groups = useMemo(() => groupProjectsByTeam(projects), [projects]);
  const selected = projects.find((p) => p.id === value);
  const displayText = selected?.name ?? placeholder;

  // Team owning the current project, so opening the menu lands on the relevant column.
  const selectedTeamId = useMemo(
    () => groups.find((g) => g.projects.some((p) => p.id === value))?.id ?? groups[0]?.id ?? null,
    [groups, value],
  );

  useLayoutEffect(() => {
    if (measureRef.current) setWidth(measureRef.current.offsetWidth);
  }, [displayText]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggle() {
    if (!open) setActiveTeamId(selectedTeamId);
    setOpen((o) => !o);
  }

  const activeGroup = groups.find((g) => g.id === activeTeamId) ?? groups[0] ?? null;

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          ...headerInputStyle,
          width,
          maxWidth,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          cursor: "pointer",
          color: selected ? "var(--text)" : "var(--text-muted)",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayText}</span>
        <span aria-hidden style={{ color: "var(--text-muted)", fontSize: 10 }}>▾</span>
      </button>

      {/* Off-screen copy of the button label, used to measure the natural width. */}
      <span
        ref={measureRef}
        aria-hidden
        style={{
          ...headerInputStyle,
          position: "absolute",
          top: 0,
          left: 0,
          visibility: "hidden",
          whiteSpace: "nowrap",
          pointerEvents: "none",
          boxSizing: "border-box",
          paddingRight: 34,
        }}
      >
        {displayText}
      </span>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            display: "flex",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
            overflow: "hidden",
          }}
        >
          {/* Fixed width + no shrinking: the pane must not resize when the highlight moves,
              nor when the right pane's content changes the flex layout. */}
          <div style={{ width: TEAM_PANE_WIDTH, flexShrink: 0, maxHeight: PANEL_MAX_HEIGHT, overflowY: "auto", padding: 4, borderRight: "1px solid var(--border)" }}>
            {groups.length === 0 && (
              <div style={{ ...rowStyle, color: "var(--text-muted)", cursor: "default" }}>No project</div>
            )}
            {groups.map((group) => {
              const active = activeGroup?.id === group.id;
              return (
                <button
                  key={group.id}
                  type="button"
                  role="menuitem"
                  onMouseEnter={() => setActiveTeamId(group.id)}
                  onFocus={() => setActiveTeamId(group.id)}
                  onClick={() => setActiveTeamId(group.id)}
                  title={group.name}
                  style={{
                    ...rowStyle,
                    justifyContent: "space-between",
                    background: active ? "var(--surface-hover)" : "transparent",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{group.name}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: 11, flexShrink: 0 }}>{group.projects.length} ›</span>
                </button>
              );
            })}
          </div>

          <div style={{ width: PROJECT_PANE_WIDTH, flexShrink: 0, maxHeight: PANEL_MAX_HEIGHT, overflowY: "auto", padding: 4 }}>
            {activeGroup?.projects.map((project) => {
              const isSelected = project.id === value;
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onChange(project.id);
                    setOpen(false);
                  }}
                  // The team rows get their highlight from `activeTeamId`; project rows have no
                  // such state, so track the hovered one explicitly (inline styles can't :hover).
                  onMouseEnter={() => setHoveredProjectId(project.id)}
                  onMouseLeave={() => setHoveredProjectId((id) => (id === project.id ? null : id))}
                  onFocus={() => setHoveredProjectId(project.id)}
                  onBlur={() => setHoveredProjectId((id) => (id === project.id ? null : id))}
                  style={{
                    ...rowStyle,
                    background: isSelected || hoveredProjectId === project.id ? "var(--surface-hover)" : "transparent",
                    fontWeight: isSelected ? 600 : 400,
                    whiteSpace: "normal",
                  }}
                >
                  {project.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
