import { useMemo, useRef, useState, useCallback } from "react";
import type { ScheduleResult, ScheduledIssue, MilestoneInfo } from "./scheduler";
import { dayToDate, formatDate } from "./scheduler";
import { StatusCircle, BlockedIcon, PriorityIcon, AssigneeAvatar, DurationBadge, MilestoneHeader, Legend, buildMilestoneSummary, BLOCKED_STRIPE, NO_ESTIMATE_BG, type MilestoneSummaryData } from "./StatusCircle";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 72;
const H_GAP = 24;
const V_GAP = 50;
const PADDING = 40;
const LABEL_WIDTH = 220;

interface TreeNode {
  issue: ScheduledIssue;
  depth: number;
  x: number;
  y: number;
  parentIds: string[];
}

interface MilestoneSection {
  milestone: MilestoneInfo | null;
  name: string;
  summary: MilestoneSummaryData;
  nodes: TreeNode[];
  edges: Array<{ from: TreeNode; to: TreeNode }>;
  contentWidth: number;
  contentHeight: number;
}

export function DependencyTree({ schedule }: { schedule: ScheduleResult }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltipInfo, setTooltipInfo] = useState<{ issue: ScheduledIssue; x: number; y: number } | null>(null);

  // Drag-to-pan state
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

  const sections = useMemo(() => {
    const issueById = new Map(schedule.issues.map((i) => [i.id, i]));

    // Build parent map (within-project blockers)
    const parentsOf = new Map<string, string[]>();
    for (const issue of schedule.issues) {
      parentsOf.set(
        issue.id,
        issue.blockedBy
          .map((b) => schedule.issues.find((i) => i.identifier === b.identifier)?.id)
          .filter((id): id is string => !!id),
      );
    }

    // Children map
    const childrenOf = new Map<string, string[]>();
    for (const issue of schedule.issues) childrenOf.set(issue.id, []);
    for (const [childId, pIds] of parentsOf) {
      for (const pId of pIds) childrenOf.get(pId)?.push(childId);
    }

    // Compute depth within each milestone
    const depthMap = new Map<string, number>();
    function getDepth(id: string, visited: Set<string>): number {
      if (visited.has(id)) return 0;
      visited.add(id);
      if (depthMap.has(id)) return depthMap.get(id)!;
      const issue = issueById.get(id);
      const sameMs = (parentsOf.get(id) ?? []).filter((pId) => {
        const p = issueById.get(pId);
        return p && (p.milestone?.id ?? null) === (issue?.milestone?.id ?? null);
      });
      const d = sameMs.length === 0 ? 0 : Math.max(...sameMs.map((p) => getDepth(p, visited))) + 1;
      depthMap.set(id, d);
      return d;
    }
    for (const issue of schedule.issues) getDepth(issue.id, new Set());

    // Milestones
    const milestoneOrder: Array<{ id: string | null; name: string }> = [
      ...schedule.milestones.map((m) => ({ id: m.id as string | null, name: m.name })),
    ];
    const noMsIssues = schedule.issues.filter((i) => !i.milestone);
    if (noMsIssues.length > 0) milestoneOrder.push({ id: null, name: "No milestone" });

    const sections: MilestoneSection[] = [];

    for (const ms of milestoneOrder) {
      const msIssues = schedule.issues.filter((i) => (i.milestone?.id ?? null) === ms.id);
      const summary = buildMilestoneSummary(msIssues, schedule.startDate, schedule.usedWorkers);

      const nodeMap = new Map<string, TreeNode>();

      // Group by depth
      const byDepth = new Map<number, ScheduledIssue[]>();
      for (const issue of msIssues) {
        const d = depthMap.get(issue.id) ?? 0;
        if (!byDepth.has(d)) byDepth.set(d, []);
        byDepth.get(d)!.push(issue);
      }
      const maxDepth = byDepth.size > 0 ? Math.max(...byDepth.keys()) : -1;

      const sectionNodes: TreeNode[] = [];

      // Pass 1: place nodes with parent-aware positioning
      for (let d = 0; d <= maxDepth; d++) {
        const issues = byDepth.get(d) ?? [];
        issues.sort((a, b) => {
          const aParents = (parentsOf.get(a.id) ?? []).map((pid) => nodeMap.get(pid)).filter(Boolean) as TreeNode[];
          const bParents = (parentsOf.get(b.id) ?? []).map((pid) => nodeMap.get(pid)).filter(Boolean) as TreeNode[];
          const aCenter = aParents.length > 0 ? aParents.reduce((s, p) => s + p.x, 0) / aParents.length : 0;
          const bCenter = bParents.length > 0 ? bParents.reduce((s, p) => s + p.x, 0) / bParents.length : 0;
          return aCenter - bCenter;
        });

        const y = PADDING + d * (NODE_HEIGHT + V_GAP);

        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i];
          const parents = (parentsOf.get(issue.id) ?? [])
            .map((pid) => nodeMap.get(pid))
            .filter(Boolean) as TreeNode[];

          let targetX: number;
          if (parents.length > 0) {
            targetX = parents.reduce((s, p) => s + p.x, 0) / parents.length;
          } else {
            targetX = i * (NODE_WIDTH + H_GAP);
          }

          // Avoid overlap with already-placed nodes at this depth
          const placedAtDepth = sectionNodes.filter((n) => n.depth === d);
          for (const placed of placedAtDepth) {
            const minX = placed.x + NODE_WIDTH + H_GAP;
            if (targetX < minX && targetX > placed.x - NODE_WIDTH - H_GAP) {
              targetX = minX;
            }
          }

          const node: TreeNode = { issue, depth: d, x: targetX, y, parentIds: parentsOf.get(issue.id) ?? [] };
          sectionNodes.push(node);
          nodeMap.set(issue.id, node);
        }
      }

      // Pass 2: center each depth row around x=0
      const sectionByDepth = new Map<number, TreeNode[]>();
      for (const node of sectionNodes) {
        if (!sectionByDepth.has(node.depth)) sectionByDepth.set(node.depth, []);
        sectionByDepth.get(node.depth)!.push(node);
      }
      for (const [, rowNodes] of sectionByDepth) {
        if (rowNodes.length === 0) continue;
        const minX = Math.min(...rowNodes.map((n) => n.x));
        const maxX = Math.max(...rowNodes.map((n) => n.x + NODE_WIDTH));
        const rowCenter = (minX + maxX) / 2;
        for (const node of rowNodes) node.x -= rowCenter;
      }

      // Edges within this section
      const edges: Array<{ from: TreeNode; to: TreeNode }> = [];
      for (const node of sectionNodes) {
        for (const parentId of node.parentIds) {
          const parent = nodeMap.get(parentId);
          if (parent) edges.push({ from: parent, to: node });
        }
      }

      // Content dimensions
      let maxHalf = 0;
      for (const node of sectionNodes) {
        maxHalf = Math.max(maxHalf, Math.abs(node.x), Math.abs(node.x + NODE_WIDTH));
      }
      const contentWidth = maxHalf * 2 + PADDING * 2;
      const contentHeight = sectionNodes.length > 0
        ? (maxDepth + 1) * (NODE_HEIGHT + V_GAP) + PADDING * 2 - V_GAP + PADDING
        : V_GAP + PADDING * 2;

      sections.push({
        milestone: ms.id ? schedule.milestones.find((m) => m.id === ms.id) ?? null : null,
        name: ms.name,
        summary,
        nodes: sectionNodes,
        edges,
        contentWidth,
        contentHeight,
      });
    }

    return sections;
  }, [schedule]);

  const maxContentWidth = Math.max(...sections.map((s) => s.contentWidth), 400);

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
        <div style={{ display: "flex", minWidth: LABEL_WIDTH + maxContentWidth }}>
          {/* Left labels */}
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
            {sections.map((section) => (
              <div
                key={section.name}
                style={{
                  minHeight: section.contentHeight,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-start",
                  padding: "10px 12px",
                  borderTop: "2px solid var(--iteration-line)",
                  background: "var(--surface)",
                  overflow: "hidden",
                  gap: 1,
                }}
              >
                <MilestoneHeader name={section.name} summary={section.summary} />
              </div>
            ))}
          </div>

          {/* Tree area */}
          <div style={{ flex: 1 }}>
            {sections.map((section) => {
              const sectionKey = section.name;
              const width = Math.max(section.contentWidth, maxContentWidth);
              const centerX = width / 2;

              return (
                <div
                  key={sectionKey}
                  style={{
                    position: "relative",
                    height: section.contentHeight,
                    borderTop: "2px solid var(--iteration-line)",
                  }}
                >
                  {/* SVG edges */}
                  <svg
                    width={width}
                    height={section.contentHeight}
                    style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", zIndex: 1 }}
                  >
                    {section.edges.map((e, i) => {
                      const x1 = centerX + e.from.x + NODE_WIDTH / 2;
                      const y1 = e.from.y + NODE_HEIGHT;
                      const x2 = centerX + e.to.x + NODE_WIDTH / 2;
                      const y2 = e.to.y;
                      const arrowSize = 6;
                      const y2adj = y2 - arrowSize;
                      const cy1 = y1 + (y2adj - y1) * 0.35;
                      const cy2 = y2adj - (y2adj - y1) * 0.35;
                      const tx = 0;
                      const ty = 3 * (y2adj - cy2);
                      const angle = Math.atan2(ty || 1, tx);
                      const ax1 = x2 + arrowSize * Math.cos(angle + 2.6);
                      const ay1 = y2 + arrowSize * Math.sin(angle + 2.6);
                      const ax2 = x2 + arrowSize * Math.cos(angle - 2.6);
                      const ay2 = y2 + arrowSize * Math.sin(angle - 2.6);
                      return (
                        <g key={`edge-${i}`} opacity={0.4}>
                          <path
                            d={`M${x1} ${y1} C${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2adj}`}
                            fill="none" stroke="var(--text-muted)" strokeWidth={1.5}
                          />
                          <polygon
                            points={`${x2},${y2} ${ax1},${ay1} ${ax2},${ay2}`}
                            fill="var(--text-muted)"
                          />
                        </g>
                      );
                    })}
                  </svg>

                  {/* Node cards */}
                  {section.nodes.map((node) => {
                    const isBlocked = node.issue.blockedBy.some((b) => !b.done);
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
                          left: centerX + node.x,
                          top: node.y,
                          width: NODE_WIDTH,
                          height: NODE_HEIGHT,
                          background: [
                            isBlocked ? BLOCKED_STRIPE : null,
                            !node.issue.hasEstimate ? NO_ESTIMATE_BG : "var(--surface-hover)",
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
                      </div>
                    );
                  })}
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
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {tooltipInfo.issue.identifier}: {tooltipInfo.issue.title}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
              {tooltipInfo.issue.assigneeName && <><AssigneeAvatar url={tooltipInfo.issue.assigneeAvatarUrl} name={tooltipInfo.issue.assigneeName} size={14} /><span>{tooltipInfo.issue.assigneeName}</span></>}
              {tooltipInfo.issue.assigneeName && tooltipInfo.issue.priority > 0 && <span>&middot;</span>}
              {tooltipInfo.issue.priority > 0 && <><PriorityIcon priority={tooltipInfo.issue.priority} size={14} /><span>{tooltipInfo.issue.priorityLabel}</span></>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
              <StatusCircle stateType={tooltipInfo.issue.stateType} color={tooltipInfo.issue.stateColor} progress={tooltipInfo.issue.stateProgress} size={12} />
              <span>{tooltipInfo.issue.stateName}</span>
              <span>&middot;</span>
              <DurationBadge issue={tooltipInfo.issue} />
              <span>&middot;</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><span>{tooltipInfo.issue.daysSpent === null ? "~" : ""}{formatDate(dayToDate(schedule.startDate, tooltipInfo.issue.startDay))}</span><span style={{ position: "relative", top: -2 }}>→</span><span>{!tooltipInfo.issue.done ? "~" : ""}{formatDate(dayToDate(schedule.startDate, tooltipInfo.issue.endDay - 1))}</span></span>
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
