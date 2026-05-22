import { type CSSProperties, useMemo } from "react";
import type { ScheduledIssue } from "./scheduler";
import { StatusCircle } from "./StatusCircle";
import { BlockedIcon } from "./CardIcons";
import { BLOCKED_STRIPE, NO_ESTIMATE_BG, DONE_STRIPE } from "./cardStyle";

interface LegendProps {
  issues: ScheduledIssue[];
  showOptions?: {
    showWeekends: boolean;
    setShowWeekends: (v: boolean) => void;
    showHolidays: boolean;
    setShowHolidays: (v: boolean) => void;
    showCooldown: boolean;
    setShowCooldown: (v: boolean) => void;
  };
}

const checkboxLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 12,
  color: "var(--text-muted)",
  cursor: "pointer",
};

export function Legend({ issues, showOptions }: LegendProps) {
  const statuses = useMemo(() => {
    const seen = new Map<string, { name: string; type: string; color: string; progress: number }>();
    for (const issue of issues) {
      if (!seen.has(issue.stateName)) {
        seen.set(issue.stateName, { name: issue.stateName, type: issue.stateType, color: issue.stateColor, progress: issue.stateProgress });
      }
    }
    const typeOrder: Record<string, number> = { backlog: 0, triage: 1, unstarted: 2, started: 3, completed: 4, canceled: 5 };
    return Array.from(seen.values()).sort((a, b) => {
      const ta = typeOrder[a.type] ?? 9;
      const tb = typeOrder[b.type] ?? 9;
      if (ta !== tb) return ta - tb;
      return a.progress - b.progress;
    });
  }, [issues]);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "12px 16px", fontSize: 12, color: "var(--text-muted)", alignItems: "center" }}>
      {statuses.map((s) => (
        <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <StatusCircle stateType={s.type} color={s.color} progress={s.progress} size={12} />
          <span>{s.name}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <div style={{ width: 24, height: 12, borderRadius: 2, background: NO_ESTIMATE_BG, border: "1px solid var(--border)" }} />
        <span>No estimate (default 3d)</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <div style={{ width: 24, height: 12, borderRadius: 2, background: `${BLOCKED_STRIPE}, var(--surface-hover)`, border: "1px solid var(--border)" }} />
        <BlockedIcon size={12} />
        <span>Blocked</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <div style={{ width: 24, height: 12, borderRadius: 2, background: `${DONE_STRIPE}, var(--surface-hover)`, border: "1px solid var(--border)" }} />
        <span>Done</span>
      </div>
      {showOptions && (
        <>
          <div style={{ flex: 1 }} />
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={showOptions.showWeekends} onChange={(e) => showOptions.setShowWeekends(e.target.checked)} />
            Show weekends
          </label>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={showOptions.showHolidays} onChange={(e) => showOptions.setShowHolidays(e.target.checked)} />
            Show holidays
          </label>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={showOptions.showCooldown} onChange={(e) => showOptions.setShowCooldown(e.target.checked)} />
            Show cooldown
          </label>
        </>
      )}
    </div>
  );
}
