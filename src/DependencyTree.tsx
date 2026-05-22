import { useRef, useState, useCallback, useEffect } from "react";
import type { ScheduleResult, ScheduledIssue, MilestoneInfo } from "./scheduler";
import { dayToDate, formatDate } from "./scheduler";
import { StatusCircle, BlockedIcon, PriorityIcon, AssigneeAvatar, DurationBadge, MilestoneHeader, Legend, buildMilestoneSummary, BLOCKED_STRIPE, NO_ESTIMATE_BG, type MilestoneSummaryData } from "./StatusCircle";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 88;
const PADDING = 40;
const LABEL_WIDTH = 220;

const elk = new ELK();

interface TreeNode {
  issue: ScheduledIssue;
  x: number;
  y: number;
  parentIds: string[];
}

interface LayoutEdge {
  from: TreeNode;
  to: TreeNode;
  sections?: Array<{
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }>;
}

interface MilestoneSection {
  milestone: MilestoneInfo | null;
  name: string;
  summary: MilestoneSummaryData;
  nodes: TreeNode[];
  edges: LayoutEdge[];
  contentWidth: number;
  contentHeight: number;
}

function buildSections(schedule: ScheduleResult): {
  milestoneOrder: Array<{ id: string | null; name: string }>;
  msIssuesMap: Map<string | null, ScheduledIssue[]>;
  parentsOf: Map<string, string[]>;
  summaries: Map<string | null, MilestoneSummaryData>;
} {
  const parentsOf = new Map<string, string[]>();
  for (const issue of schedule.issues) {
    parentsOf.set(
      issue.id,
      issue.blockedBy
        .map((b) => schedule.issues.find((i) => i.identifier === b.identifier)?.id)
        .filter((id): id is string => !!id),
    );
  }

  const milestoneOrder: Array<{ id: string | null; name: string }> = [
    ...schedule.milestones.map((m) => ({ id: m.id as string | null, name: m.name })),
  ];
  const noMsIssues = schedule.issues.filter((i) => !i.milestone);
  if (noMsIssues.length > 0) milestoneOrder.push({ id: null, name: "No milestone" });

  const msIssuesMap = new Map<string | null, ScheduledIssue[]>();
  const summaries = new Map<string | null, MilestoneSummaryData>();
  for (const ms of milestoneOrder) {
    const msIssues = schedule.issues.filter((i) => (i.milestone?.id ?? null) === ms.id);
    msIssuesMap.set(ms.id, msIssues);
    summaries.set(ms.id, buildMilestoneSummary(msIssues, schedule.startDate, schedule.usedWorkers));
  }

  return { milestoneOrder, msIssuesMap, parentsOf, summaries };
}

async function layoutWithElk(
  schedule: ScheduleResult,
  milestoneOrder: Array<{ id: string | null; name: string }>,
  msIssuesMap: Map<string | null, ScheduledIssue[]>,
  parentsOf: Map<string, string[]>,
  summaries: Map<string | null, MilestoneSummaryData>,
): Promise<MilestoneSection[]> {
  const sections: MilestoneSection[] = [];
  const issueIdSet = new Set(schedule.issues.map((i) => i.id));

  for (const ms of milestoneOrder) {
    const msIssues = msIssuesMap.get(ms.id) ?? [];
    const summary = summaries.get(ms.id)!;

    if (msIssues.length === 0) {
      sections.push({
        milestone: ms.id ? schedule.milestones.find((m) => m.id === ms.id) ?? null : null,
        name: ms.name,
        summary,
        nodes: [],
        edges: [],
        contentWidth: 0,
        contentHeight: PADDING * 2,
      });
      continue;
    }

    const msIssueIds = new Set(msIssues.map((i) => i.id));
    const elkEdges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
    for (const issue of msIssues) {
      const pIds = (parentsOf.get(issue.id) ?? []).filter((pid) => msIssueIds.has(pid) && issueIdSet.has(pid));
      for (const pid of pIds) {
        elkEdges.push({ id: `e-${pid}-${issue.id}`, sources: [pid], targets: [issue.id] });
      }
    }

    const elkGraph = {
      id: `ms-${ms.id ?? "none"}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.layered.spacing.nodeNodeBetweenLayers": "50",
        "elk.spacing.nodeNode": "24",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
        "elk.edgeRouting": "SPLINES",
        "elk.layered.spacing.edgeEdgeBetweenLayers": "15",
        "elk.layered.spacing.edgeNodeBetweenLayers": "25",
      },
      children: msIssues.map((issue) => ({
        id: issue.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      edges: elkEdges,
    };

    const layout = (await elk.layout(elkGraph)) as ElkNode;

    const nodeMap = new Map<string, TreeNode>();
    const issueMap = new Map(msIssues.map((i) => [i.id, i]));

    for (const child of layout.children ?? []) {
      const issue = issueMap.get(child.id);
      if (!issue) continue;
      const node: TreeNode = {
        issue,
        x: (child.x ?? 0) + PADDING,
        y: (child.y ?? 0) + PADDING,
        parentIds: (parentsOf.get(issue.id) ?? []).filter((pid) => msIssueIds.has(pid)),
      };
      nodeMap.set(issue.id, node);
    }

    const edges: LayoutEdge[] = [];
    for (const elkEdge of (layout.edges ?? []) as ElkExtendedEdge[]) {
      const fromId = elkEdge.sources?.[0];
      const toId = elkEdge.targets?.[0];
      if (!fromId || !toId) continue;
      const from = nodeMap.get(fromId);
      const to = nodeMap.get(toId);
      if (!from || !to) continue;
      edges.push({
        from,
        to,
        sections: elkEdge.sections?.map((s) => ({
          startPoint: { x: (s.startPoint?.x ?? 0) + PADDING, y: (s.startPoint?.y ?? 0) + PADDING },
          endPoint: { x: (s.endPoint?.x ?? 0) + PADDING, y: (s.endPoint?.y ?? 0) + PADDING },
          bendPoints: s.bendPoints?.map((bp) => ({ x: (bp.x ?? 0) + PADDING, y: (bp.y ?? 0) + PADDING })),
        })),
      });
    }

    const nodes = Array.from(nodeMap.values());
    const contentWidth = (layout.width ?? 400) + PADDING * 2;
    const contentHeight = (layout.height ?? 200) + PADDING * 2;

    sections.push({
      milestone: ms.id ? schedule.milestones.find((m) => m.id === ms.id) ?? null : null,
      name: ms.name,
      summary,
      nodes,
      edges,
      contentWidth,
      contentHeight,
    });
  }

  return sections;
}

function edgePath(edge: LayoutEdge): string {
  if (edge.sections && edge.sections.length > 0) {
    const parts: string[] = [];
    for (const section of edge.sections) {
      const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      if (pts.length < 2) continue;
      if (parts.length === 0) {
        parts.push(`M${pts[0].x} ${pts[0].y}`);
      }
      if (pts.length === 2) {
        parts.push(`L${pts[1].x} ${pts[1].y}`);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const prev = pts[i - 1];
          const curr = pts[i];
          const next = pts[i + 1];
          const c1x = (prev.x + curr.x) / 2;
          const c1y = (prev.y + curr.y) / 2;
          const c2x = (curr.x + next.x) / 2;
          const c2y = (curr.y + next.y) / 2;
          if (i === 1) parts.push(`L${c1x} ${c1y}`);
          parts.push(`Q${curr.x} ${curr.y} ${c2x} ${c2y}`);
        }
        parts.push(`L${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`);
      }
    }
    return parts.join(" ");
  }
  const x1 = edge.from.x + NODE_WIDTH / 2;
  const y1 = edge.from.y + NODE_HEIGHT;
  const x2 = edge.to.x + NODE_WIDTH / 2;
  const y2 = edge.to.y;
  const cy1 = y1 + (y2 - y1) * 0.35;
  const cy2 = y2 - (y2 - y1) * 0.35;
  return `M${x1} ${y1} C${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
}

export function DependencyTree({ schedule }: { schedule: ScheduleResult }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltipInfo, setTooltipInfo] = useState<{ issue: ScheduledIssue; x: number; y: number } | null>(null);
  const [sections, setSections] = useState<MilestoneSection[]>([]);

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
    const { milestoneOrder, msIssuesMap, parentsOf, summaries } = buildSections(schedule);
    let cancelled = false;
    layoutWithElk(schedule, milestoneOrder, msIssuesMap, parentsOf, summaries).then((result) => {
      if (!cancelled) setSections(result);
    });
    return () => { cancelled = true; };
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
                          left: node.x,
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
                            WebkitLineClamp: node.issue.labels.length > 0 ? 1 : 2,
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

function formatParisTimeOfDay(isoString: string): string {
  const h = parseInt(new Date(isoString).toLocaleString("en-US", { timeZone: "Europe/Paris", hour: "numeric", hour12: false }), 10);
  return h < 13 ? "morning" : "afternoon";
}
