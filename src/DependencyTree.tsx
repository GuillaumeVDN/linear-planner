import { useRef, useState, useCallback, useEffect } from "react";
import type { ScheduleResult, ScheduledIssue } from "./scheduler";
import { dayToDate, formatDate, formatParisTimeOfDay } from "./workingDays";
import { StatusCircle } from "./StatusCircle";
import { BlockedIcon, PriorityIcon, AssigneeAvatar, DurationBadge } from "./CardIcons";
import { MilestoneHeader } from "./MilestoneHeader";
import { Legend } from "./Legend";
import { BLOCKED_STRIPE, NO_ESTIMATE_BG, DONE_STRIPE, ongoingStatusBg, isBlockedDisplay } from "./cardStyle";
import { layoutDependencyTree, layoutDependencyTreeGlobal, layoutDependencyTreePerMilestone, edgePath, NODE_WIDTH, NODE_HEIGHT, type TreeLayoutResult } from "./treeLayout";

const LABEL_WIDTH = 220;

const EMPTY_LAYOUT: TreeLayoutResult = { nodes: [], edges: [], bands: [], contentWidth: 0, contentHeight: 0 };

export type TreeVariant = "split" | "individual" | "global";

export function DependencyTree({ schedule, variant = "split" }: { schedule: ScheduleResult; variant?: TreeVariant }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltipInfo, setTooltipInfo] = useState<{ issue: ScheduledIssue; x: number; y: number } | null>(null);
  const [layout, setLayout] = useState<TreeLayoutResult>(EMPTY_LAYOUT);

  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-card]")) return;
    const el = containerRef.current;
    if (!el) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    e.preventDefault();
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollLeft = dragStart.current.scrollLeft - (e.clientX - dragStart.current.x);
    el.scrollTop = dragStart.current.scrollTop - (e.clientY - dragStart.current.y);
  }, [isDragging]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  useEffect(() => {
    let cancelled = false;
    const layoutFn = variant === "global"
      ? layoutDependencyTreeGlobal
      : variant === "individual"
        ? layoutDependencyTreePerMilestone
        : layoutDependencyTree;
    layoutFn(schedule).then((result) => {
      if (!cancelled) setLayout(result);
    });
    return () => { cancelled = true; };
  }, [schedule, variant]);

  const contentWidth = Math.max(layout.contentWidth, 400);
  const contentHeight = Math.max(layout.contentHeight, 100);

  return (
    <>
      <Legend issues={schedule.issues} />
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          overflowX: "auto",
          overflowY: "hidden",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          position: "relative",
          cursor: isDragging ? "grabbing" : "default",
        }}
      >
        <div style={{ display: "flex", minWidth: (layout.bands.length > 0 ? LABEL_WIDTH : 0) + contentWidth, height: contentHeight }}>
          {/* Left labels — one block per milestone, sized to that milestone's band */}
          {layout.bands.length > 0 && (
            <div
              style={{
                width: LABEL_WIDTH,
                minWidth: LABEL_WIDTH,
                position: "sticky",
                left: 0,
                zIndex: 20,
                background: "var(--surface)",
                borderRight: "1px solid var(--border)",
              }}
            >
              {layout.bands.map((band) => (
                <div
                  key={band.name}
                  style={{
                    height: band.yEnd - band.yStart,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-start",
                    padding: "10px 12px",
                    borderTop: "2px solid var(--iteration-line)",
                    background: "var(--surface)",
                    overflow: "hidden",
                    gap: 1,
                    boxSizing: "border-box",
                  }}
                >
                  <MilestoneHeader name={band.name} summary={band.summary} />
                </div>
              ))}
            </div>
          )}

          {/* Tree area — single SVG for all edges (including cross-milestone) + all nodes */}
          <div style={{ flex: 1, position: "relative", height: contentHeight }}>
            {/* Horizontal milestone separators (border-top at each band's yStart) */}
            {layout.bands.map((band) => (
              <div
                key={`sep-${band.name}`}
                style={{
                  position: "absolute",
                  left: 0,
                  top: band.yStart,
                  width: contentWidth,
                  height: 2,
                  background: "var(--iteration-line)",
                  zIndex: 3,
                  pointerEvents: "none",
                }}
              />
            ))}

            {/* SVG edges */}
            <svg
              width={contentWidth}
              height={contentHeight}
              style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 1 }}
            >
              {layout.edges.map((e, i) => {
                const d = edgePath(e);
                const endPt = e.sections?.at(-1)?.endPoint ?? { x: e.to.x + NODE_WIDTH / 2, y: e.to.y };
                const arrowSize = 6;
                const prevPt = e.sections?.at(-1)?.bendPoints?.at(-1) ?? e.sections?.at(-1)?.startPoint ?? { x: e.from.x + NODE_WIDTH / 2, y: e.from.y + NODE_HEIGHT };
                const angle = Math.atan2(endPt.y - prevPt.y, endPt.x - prevPt.x);
                const ax1 = endPt.x - arrowSize * Math.cos(angle - 0.5);
                const ay1 = endPt.y - arrowSize * Math.sin(angle - 0.5);
                const ax2 = endPt.x - arrowSize * Math.cos(angle + 0.5);
                const ay2 = endPt.y - arrowSize * Math.sin(angle + 0.5);
                return (
                  <g key={`edge-${i}`} opacity={0.4}>
                    <path d={d} fill="none" stroke="var(--text-muted)" strokeWidth={1.5} />
                    <polygon
                      points={`${endPt.x},${endPt.y} ${ax1},${ay1} ${ax2},${ay2}`}
                      fill="var(--text-muted)"
                    />
                  </g>
                );
              })}
            </svg>

            {/* Node cards */}
            {layout.nodes.map((node) => {
              const isBlocked = isBlockedDisplay(node.issue);
              return (
                <div
                  key={node.issue.id}
                  data-card
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltipInfo({ issue: node.issue, x: rect.left + rect.width / 2, y: rect.top });
                  }}
                  onMouseLeave={() => setTooltipInfo(null)}
                  onClick={() => window.open(node.issue.url, "_blank")}
                  style={{
                    position: "absolute",
                    left: node.x,
                    top: node.y,
                    width: NODE_WIDTH,
                    height: NODE_HEIGHT,
                    background: [
                      isBlocked ? BLOCKED_STRIPE : null,
                      node.issue.done ? DONE_STRIPE : null,
                      ongoingStatusBg(node.issue.stateType, node.issue.done, node.issue.stateColor) ?? (!node.issue.hasEstimate ? NO_ESTIMATE_BG : "var(--surface-hover)"),
                    ].filter(Boolean).join(", "),
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    gap: 4,
                    cursor: "pointer",
                    opacity: node.issue.done ? 0.5 : 1,
                    fontSize: 11,
                    overflow: "hidden",
                    zIndex: 2,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <AssigneeAvatar url={node.issue.assigneeAvatarUrl} name={node.issue.assigneeName} size={18} />
                    <StatusCircle
                      stateType={node.issue.stateType}
                      color={node.issue.stateColor}
                      progress={node.issue.stateProgress}
                      size={14}
                    />
                    {isBlocked && <BlockedIcon />}
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
                      {node.issue.identifier}
                    </span>
                    <DurationBadge issue={node.issue} style={{ fontSize: 10, color: "var(--text-muted)" }} />
                  </div>
                  <div
                    title={node.issue.title}
                    style={{
                      color: "var(--text)",
                      fontWeight: 500,
                      lineHeight: 1.3,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {node.issue.title}
                  </div>
                  {node.issue.labels.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, overflow: "hidden", maxHeight: 18 }}>
                      {node.issue.labels.map((l) => (
                        <span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9, padding: "0 4px", borderRadius: 3, background: `${l.color}20`, color: l.color, fontWeight: 500, whiteSpace: "nowrap", lineHeight: "16px" }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: l.color, flexShrink: 0 }} />
                          {l.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Tooltip */}
        {tooltipInfo && (
          <div
            style={{
              position: "fixed", left: tooltipInfo.x, top: tooltipInfo.y - 8,
              transform: "translate(-50%, -100%)",
              background: "var(--surface-hover)", border: "1px solid var(--border)",
              borderRadius: 6, padding: "8px 12px", fontSize: 12, zIndex: 100,
              pointerEvents: "none", maxWidth: 320,
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {tooltipInfo.issue.identifier}: {tooltipInfo.issue.title}
            </div>
            {tooltipInfo.issue.labels.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                {tooltipInfo.issue.labels.map((l) => (
                  <span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, padding: "1px 6px", borderRadius: 3, background: `${l.color}20`, color: l.color, fontWeight: 500 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: l.color, flexShrink: 0 }} />
                    {l.name}
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
              {tooltipInfo.issue.assigneeName && <><AssigneeAvatar url={tooltipInfo.issue.assigneeAvatarUrl} name={tooltipInfo.issue.assigneeName} size={14} /><span>{tooltipInfo.issue.assigneeName}</span></>}
              {tooltipInfo.issue.assigneeName && tooltipInfo.issue.priority > 0 && <span>&middot;</span>}
              {tooltipInfo.issue.priority > 0 && <><PriorityIcon priority={tooltipInfo.issue.priority} size={14} /><span>{tooltipInfo.issue.priorityLabel}</span></>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              <StatusCircle stateType={tooltipInfo.issue.stateType} color={tooltipInfo.issue.stateColor} progress={tooltipInfo.issue.stateProgress} size={12} />
              <span>{tooltipInfo.issue.stateName}</span>
              <span>&middot;</span>
              <DurationBadge issue={tooltipInfo.issue} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              <span>{tooltipInfo.issue.daysSpent === null ? "~" : ""}{formatDate(dayToDate(schedule.startDate, tooltipInfo.issue.startDay))}{tooltipInfo.issue.startedAtRaw ? `, ${formatParisTimeOfDay(tooltipInfo.issue.startedAtRaw)}` : ""}</span><span style={{ position: "relative", top: -2 }}>→</span><span>{!tooltipInfo.issue.done ? "~" : ""}{formatDate(dayToDate(schedule.startDate, tooltipInfo.issue.endDay - 1))}{tooltipInfo.issue.endedAtRaw ? `, ${formatParisTimeOfDay(tooltipInfo.issue.endedAtRaw)}` : ""}</span>
            </div>
            {!tooltipInfo.issue.done && tooltipInfo.issue.blockedBy.filter((b) => !b.done).length > 0 && (
              <div style={{ color: "var(--text-muted)", marginTop: 4, fontSize: 11 }}>
                Blocked by:
                {tooltipInfo.issue.blockedBy.filter((b) => !b.done).map((b) => (
                  <div key={b.identifier} style={{ marginLeft: 8 }}>{b.identifier} {b.title}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
