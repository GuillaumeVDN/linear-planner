import { type CSSProperties } from "react";
import type { ScheduledIssue } from "./scheduler";

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

/** Colored duration label: green = done within estimate, orange = exceeded, yellow = in progress */
export function DurationBadge({ issue, style }: { issue: ScheduledIssue; style?: CSSProperties }) {
  const spent = issue.daysSpent;
  const hasSpent = issue.hasEstimate && spent != null;
  if (!hasSpent) {
    if (!issue.hasEstimate) return <span style={style}>No estimate</span>;
    return <span style={style}>{issue.estimate} working day{issue.estimate > 1 ? "s" : ""}</span>;
  }
  if (issue.done) {
    const color = spent > issue.estimate ? "#f97316" : spent < issue.estimate ? "#22c55e" : "#15803d";
    return <span style={{ ...style, color, fontWeight: 600 }}>{spent}/{issue.estimate} working days</span>;
  }
  if (spent !== issue.estimate) {
    const color = spent > issue.estimate ? "#f97316" : "#eab308";
    return <span style={{ ...style, color, fontWeight: 600 }}>{spent}/{issue.estimate} working days</span>;
  }
  return <span style={style}>{issue.estimate} working day{issue.estimate > 1 ? "s" : ""}</span>;
}

export function BlockedIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ flexShrink: 0 }} fill="none">
      <rect x={2} y={5.5} width={8} height={5.5} rx={1} fill="var(--text-muted)" opacity={0.6} />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="var(--text-muted)" strokeWidth={1.2} strokeLinecap="round" opacity={0.6} />
    </svg>
  );
}
