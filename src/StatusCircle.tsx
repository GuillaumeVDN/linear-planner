import { type CSSProperties, useMemo } from "react";
import type { ScheduledIssue } from "./scheduler";
import { dayToDate, formatDate } from "./scheduler";

export const BLOCKED_STRIPE =
  "repeating-linear-gradient(-45deg, transparent, transparent 5px, rgba(100,100,100,0.1) 5px, rgba(100,100,100,0.1) 10px)";
export const NO_ESTIMATE_BG = "rgba(128,128,128,0.15)";

/** Pie arc path from 12 o'clock sweeping clockwise by `progress` (0-1) */
function pieArc(cx: number, cy: number, r: number, progress: number): string {
  if (progress <= 0) return "";
  if (progress >= 1) return `M${cx},${cy}m${-r},0a${r},${r},0,1,0,${r * 2},0a${r},${r},0,1,0,${-r * 2},0`;
  const angle = -Math.PI / 2 + progress * 2 * Math.PI;
  const ex = cx + r * Math.cos(angle);
  const ey = cy + r * Math.sin(angle);
  const large = progress > 0.5 ? 1 : 0;
  return `M${cx} ${cy} L${cx} ${cy - r} A${r} ${r} 0 ${large} 1 ${ex} ${ey} Z`;
}

export function StatusCircle({ stateType, color, progress = 0, size = 14 }: { stateType: string; color: string; progress?: number; size?: number }) {
  const r = size / 2;
  const cx = r;
  const cy = r;
  const sr = r - 1.5;

  if (stateType === "completed") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={sr} fill={color} />
        <path d={`M${r * 0.55} ${r} L${r * 0.85} ${r * 1.25} L${r * 1.45} ${r * 0.7}`} fill="none" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (stateType === "canceled") {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={sr} fill="none" stroke={color} strokeWidth={1.5} />
        <path d={`M${r * 0.7} ${r * 0.7} L${r * 1.3} ${r * 1.3} M${r * 1.3} ${r * 0.7} L${r * 0.7} ${r * 1.3}`} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    );
  }
  if (stateType === "started" && progress > 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={sr} fill="none" stroke={color} strokeWidth={1.5} />
        <path d={pieArc(cx, cy, sr, progress)} fill={color} />
      </svg>
    );
  }
  const dashArray = stateType === "backlog" ? `${sr * 0.8} ${sr * 0.8}` : undefined;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={sr} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={dashArray} />
    </svg>
  );
}

/** Linear-style priority bars (always 3 bars, unfilled ones for lower priority) */
export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  if (priority === 0) return null;
  const color = "var(--text-muted)";
  const totalBars = 3;
  const filledBars = priority === 1 ? 3 : priority === 2 ? 3 : priority === 3 ? 2 : 1;
  const barWidth = size / 6;
  const gap = size / 8;
  const totalW = totalBars * barWidth + (totalBars - 1) * gap;
  const startX = (size - totalW) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      {Array.from({ length: totalBars }, (_, i) => {
        const h = size * (0.4 + 0.15 * i);
        const filled = i < filledBars;
        return (
          <rect
            key={i}
            x={startX + i * (barWidth + gap)}
            y={size - h - 1}
            width={barWidth}
            height={h}
            rx={0.5}
            fill={filled ? color : "none"}
            stroke={filled ? "none" : color}
            strokeWidth={0.5}
            opacity={filled ? 1 : 0.4}
          />
        );
      })}
    </svg>
  );
}

export function AssigneeAvatar({ url, name, size = 16 }: { url: string | null; name: string | null; size?: number }) {
  if (!url && !name) return null;
  if (url) {
    return (
      <img
        src={url}
        alt={name ?? ""}
        title={name ?? ""}
        style={{ width: size, height: size, borderRadius: "50%", flexShrink: 0, objectFit: "cover" }}
      />
    );
  }
  // Fallback: initials circle
  const initials = (name ?? "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span
      title={name ?? ""}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--border)",
        color: "var(--text-muted)",
        fontSize: size * 0.45,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}

export function BlockedIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ flexShrink: 0 }} fill="none">
      <rect x={2} y={5.5} width={8} height={5.5} rx={1} fill="var(--text-muted)" opacity={0.6} />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="var(--text-muted)" strokeWidth={1.2} strokeLinecap="round" opacity={0.6} />
    </svg>
  );
}

export function buildMilestoneSummary(msIssues: ScheduledIssue[], startDate: Date): string {
  const count = msIssues.length;
  if (count === 0) return "0 issues";

  const estimatedIssues = msIssues.filter((i) => i.hasEstimate);
  if (estimatedIssues.length === 0) return `${count} issue${count !== 1 ? "s" : ""}`;

  const minStartDay = Math.min(...estimatedIssues.map((i) => i.startDay));
  const maxEndDay = Math.max(...estimatedIssues.map((i) => i.endDay));

  const hasStarted = estimatedIssues.some((i) => i.stateType === "started" || i.done);
  const allDone = estimatedIssues.every((i) => i.done);

  const startStr = hasStarted
    ? formatDate(dayToDate(startDate, minStartDay))
    : `~${formatDate(dayToDate(startDate, minStartDay))}`;
  const endStr = allDone
    ? formatDate(dayToDate(startDate, maxEndDay - 1))
    : `~${formatDate(dayToDate(startDate, maxEndDay - 1))}`;

  return `${count} issue${count !== 1 ? "s" : ""} \u00B7 ${startStr} to ${endStr}`;
}

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
