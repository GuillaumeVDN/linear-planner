import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api";
import type { ScheduleResult, ScheduledIssue, MilestoneInfo } from "./scheduler";
import { buildMilestoneSummary, type MilestoneSummaryData } from "./MilestoneHeader";

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 88;
export const PADDING = 40;

const elk = new ELK();

export interface TreeNode {
  issue: ScheduledIssue;
  x: number;
  y: number;
  parentIds: string[];
}

export interface LayoutEdge {
  from: TreeNode;
  to: TreeNode;
  /** ELK-routed sections (intra-milestone). Cross-milestone edges have no sections — rendered as a single bezier. */
  sections?: Array<{
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }>;
}

export interface MilestoneBand {
  milestone: MilestoneInfo | null;
  name: string;
  summary: MilestoneSummaryData;
  yStart: number;
  yEnd: number;
}

export interface TreeLayoutResult {
  nodes: TreeNode[];
  edges: LayoutEdge[];
  bands: MilestoneBand[];
  contentWidth: number;
  contentHeight: number;
}

function buildParentsAndMilestones(schedule: ScheduleResult) {
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

  return { parentsOf, milestoneOrder, msIssuesMap, summaries };
}

async function layoutAllMilestones(schedule: ScheduleResult): Promise<TreeLayoutResult> {
  const { parentsOf, milestoneOrder, msIssuesMap, summaries } = buildParentsAndMilestones(schedule);
  const issueIdSet = new Set(schedule.issues.map((i) => i.id));

  // Partition each issue by its milestone's index. Smaller partition = earlier (higher up).
  const partitionByIssue = new Map<string, number>();
  milestoneOrder.forEach((ms, idx) => {
    for (const issue of msIssuesMap.get(ms.id) ?? []) {
      partitionByIssue.set(issue.id, idx);
    }
  });

  const issuesInLayout = schedule.issues.filter((i) => partitionByIssue.has(i.id));
  if (issuesInLayout.length === 0) {
    return { nodes: [], edges: [], bands: [], contentWidth: 0, contentHeight: 0 };
  }

  const elkEdges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
  for (const issue of issuesInLayout) {
    for (const pid of parentsOf.get(issue.id) ?? []) {
      if (!issueIdSet.has(pid)) continue;
      elkEdges.push({ id: `e-${pid}-${issue.id}`, sources: [pid], targets: [issue.id] });
    }
  }

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.partitioning.activate": "true",
      // Keep all nodes in the same layout (don't split disconnected components into
      // separate sub-layouts — that's what stranded the orphan cards at the top).
      "elk.separateConnectedComponents": "false",
      // MIN_WIDTH layering keeps each node close to its highest source, so leaves don't
      // get pushed to the bottom of their partition's layer range.
      "elk.layered.layering.strategy": "MIN_WIDTH",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.spacing.nodeNodeBetweenLayers": "50",
      "elk.spacing.nodeNode": "24",
      "elk.edgeRouting": "SPLINES",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "15",
      "elk.layered.spacing.edgeNodeBetweenLayers": "25",
    },
    children: issuesInLayout.map((issue) => ({
      id: issue.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      layoutOptions: {
        // Zero-pad so lexical comparison agrees with numeric order even for 10+ milestones.
        "elk.partitioning.partition": String(partitionByIssue.get(issue.id)!).padStart(4, "0"),
      },
    })),
    edges: elkEdges,
  };

  const layout = (await elk.layout(elkGraph)) as ElkNode;

  const issueMap = new Map(schedule.issues.map((i) => [i.id, i]));
  const nodeMap = new Map<string, TreeNode>();
  for (const child of layout.children ?? []) {
    const issue = issueMap.get(child.id);
    if (!issue) continue;
    nodeMap.set(issue.id, {
      issue,
      x: (child.x ?? 0) + PADDING,
      y: (child.y ?? 0) + PADDING,
      parentIds: (parentsOf.get(issue.id) ?? []).filter((pid) => issueIdSet.has(pid)),
    });
  }

  const allEdges: LayoutEdge[] = [];
  for (const elkEdge of (layout.edges ?? []) as ElkExtendedEdge[]) {
    const fromId = elkEdge.sources?.[0];
    const toId = elkEdge.targets?.[0];
    if (!fromId || !toId) continue;
    const from = nodeMap.get(fromId);
    const to = nodeMap.get(toId);
    if (!from || !to) continue;
    allEdges.push({
      from,
      to,
      sections: elkEdge.sections?.map((s) => ({
        startPoint: { x: (s.startPoint?.x ?? 0) + PADDING, y: (s.startPoint?.y ?? 0) + PADDING },
        endPoint: { x: (s.endPoint?.x ?? 0) + PADDING, y: (s.endPoint?.y ?? 0) + PADDING },
        bendPoints: s.bendPoints?.map((bp) => ({ x: (bp.x ?? 0) + PADDING, y: (bp.y ?? 0) + PADDING })),
      })),
    });
  }

  // Compute bands: each non-empty milestone gets a Y range from its nodes' bounding box,
  // anchored to the previous band's end so they tile vertically without gaps.
  const BAND_PADDING = 16;
  const bands: MilestoneBand[] = [];
  let prevEnd = 0;
  for (const ms of milestoneOrder) {
    const msIssues = msIssuesMap.get(ms.id) ?? [];
    if (msIssues.length === 0) continue;
    const milestone = ms.id ? schedule.milestones.find((m) => m.id === ms.id) ?? null : null;
    const summary = summaries.get(ms.id)!;
    let maxY = prevEnd;
    for (const issue of msIssues) {
      const node = nodeMap.get(issue.id);
      if (!node) continue;
      maxY = Math.max(maxY, node.y + NODE_HEIGHT);
    }
    const yEnd = maxY + BAND_PADDING;
    bands.push({ milestone, name: ms.name, summary, yStart: prevEnd, yEnd });
    prevEnd = yEnd;
  }

  const contentWidth = (layout.width ?? 0) + PADDING * 2;
  const contentHeight = Math.max((layout.height ?? 0) + PADDING * 2, prevEnd);
  return { nodes: Array.from(nodeMap.values()), edges: allEdges, bands, contentWidth, contentHeight };
}

/** Layout the dependency tree as a single graph spanning all milestones. */
export function layoutDependencyTree(schedule: ScheduleResult): Promise<TreeLayoutResult> {
  return layoutAllMilestones(schedule);
}

/**
 * Layout the dependency tree as independent per-milestone subgraphs stacked vertically.
 * No cross-milestone edges are drawn — each milestone's tree stands on its own.
 */
export async function layoutDependencyTreePerMilestone(schedule: ScheduleResult): Promise<TreeLayoutResult> {
  const { parentsOf, milestoneOrder, msIssuesMap, summaries } = buildParentsAndMilestones(schedule);

  const BAND_TOP_PAD = 20;
  const BAND_BOTTOM_PAD = 20;
  const EMPTY_BAND_H = 60;

  const allNodes: TreeNode[] = [];
  const allEdges: LayoutEdge[] = [];
  const bands: MilestoneBand[] = [];
  let cursor = 0;
  let maxWidth = 0;

  for (const ms of milestoneOrder) {
    const msIssues = msIssuesMap.get(ms.id) ?? [];
    const summary = summaries.get(ms.id)!;
    const milestone = ms.id ? schedule.milestones.find((m) => m.id === ms.id) ?? null : null;
    const yStart = cursor;

    if (msIssues.length === 0) {
      const yEnd = yStart + EMPTY_BAND_H;
      bands.push({ milestone, name: ms.name, summary, yStart, yEnd });
      cursor = yEnd;
      continue;
    }

    const msIssueIds = new Set(msIssues.map((i) => i.id));
    const elkEdges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
    for (const issue of msIssues) {
      const pIds = (parentsOf.get(issue.id) ?? []).filter((pid) => msIssueIds.has(pid));
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
    const issueMap = new Map(msIssues.map((i) => [i.id, i]));
    const localNodes = new Map<string, TreeNode>();
    const dy = yStart + BAND_TOP_PAD;

    for (const child of layout.children ?? []) {
      const issue = issueMap.get(child.id);
      if (!issue) continue;
      const node: TreeNode = {
        issue,
        x: (child.x ?? 0) + PADDING,
        y: (child.y ?? 0) + dy,
        parentIds: (parentsOf.get(issue.id) ?? []).filter((pid) => msIssueIds.has(pid)),
      };
      localNodes.set(issue.id, node);
      allNodes.push(node);
    }

    for (const elkEdge of (layout.edges ?? []) as ElkExtendedEdge[]) {
      const fromId = elkEdge.sources?.[0];
      const toId = elkEdge.targets?.[0];
      if (!fromId || !toId) continue;
      const from = localNodes.get(fromId);
      const to = localNodes.get(toId);
      if (!from || !to) continue;
      allEdges.push({
        from,
        to,
        sections: elkEdge.sections?.map((s) => ({
          startPoint: { x: (s.startPoint?.x ?? 0) + PADDING, y: (s.startPoint?.y ?? 0) + dy },
          endPoint: { x: (s.endPoint?.x ?? 0) + PADDING, y: (s.endPoint?.y ?? 0) + dy },
          bendPoints: s.bendPoints?.map((bp) => ({ x: (bp.x ?? 0) + PADDING, y: (bp.y ?? 0) + dy })),
        })),
      });
    }

    const yEnd = yStart + BAND_TOP_PAD + (layout.height ?? 0) + BAND_BOTTOM_PAD;
    bands.push({ milestone, name: ms.name, summary, yStart, yEnd });
    cursor = yEnd;
    maxWidth = Math.max(maxWidth, (layout.width ?? 0) + PADDING * 2);
  }

  const contentWidth = Math.max(maxWidth, 400);
  return { nodes: allNodes, edges: allEdges, bands, contentWidth, contentHeight: cursor };
}

/**
 * Layout the dependency tree as one single global graph, ignoring milestones entirely.
 * Useful for getting an at-a-glance view of the full DAG without milestone vertical separation.
 */
export async function layoutDependencyTreeGlobal(schedule: ScheduleResult): Promise<TreeLayoutResult> {
  const issueIdSet = new Set(schedule.issues.map((i) => i.id));
  const parentsOf = new Map<string, string[]>();
  for (const issue of schedule.issues) {
    parentsOf.set(
      issue.id,
      issue.blockedBy
        .map((b) => schedule.issues.find((i) => i.identifier === b.identifier)?.id)
        .filter((id): id is string => !!id),
    );
  }

  if (schedule.issues.length === 0) {
    return { nodes: [], edges: [], bands: [], contentWidth: 0, contentHeight: 0 };
  }

  const elkEdges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
  for (const issue of schedule.issues) {
    for (const pid of parentsOf.get(issue.id) ?? []) {
      if (!issueIdSet.has(pid)) continue;
      elkEdges.push({ id: `e-${pid}-${issue.id}`, sources: [pid], targets: [issue.id] });
    }
  }

  const elkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.separateConnectedComponents": "false",
      "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.spacing.nodeNodeBetweenLayers": "50",
      "elk.spacing.nodeNode": "24",
      "elk.edgeRouting": "SPLINES",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "15",
      "elk.layered.spacing.edgeNodeBetweenLayers": "25",
    },
    children: schedule.issues.map((issue) => ({
      id: issue.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: elkEdges,
  };

  const layout = (await elk.layout(elkGraph)) as ElkNode;

  const issueMap = new Map(schedule.issues.map((i) => [i.id, i]));
  const nodeMap = new Map<string, TreeNode>();
  for (const child of layout.children ?? []) {
    const issue = issueMap.get(child.id);
    if (!issue) continue;
    nodeMap.set(issue.id, {
      issue,
      x: (child.x ?? 0) + PADDING,
      y: (child.y ?? 0) + PADDING,
      parentIds: (parentsOf.get(issue.id) ?? []).filter((pid) => issueIdSet.has(pid)),
    });
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

  const contentWidth = (layout.width ?? 0) + PADDING * 2;
  const contentHeight = (layout.height ?? 0) + PADDING * 2;
  return { nodes: Array.from(nodeMap.values()), edges, bands: [], contentWidth, contentHeight };
}

/** SVG path for an edge. ELK-routed edges have `sections`; cross-milestone edges fall back to a bezier. */
export function edgePath(edge: LayoutEdge): string {
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
  // Cross-milestone bezier
  const x1 = edge.from.x + NODE_WIDTH / 2;
  const y1 = edge.from.y + NODE_HEIGHT;
  const x2 = edge.to.x + NODE_WIDTH / 2;
  const y2 = edge.to.y;
  const dy = y2 - y1;
  const cy1 = y1 + dy * 0.4;
  const cy2 = y2 - dy * 0.4;
  return `M${x1} ${y1} C${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
}
