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
  sections?: Array<{
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }>;
}

export interface MilestoneSection {
  milestone: MilestoneInfo | null;
  name: string;
  summary: MilestoneSummaryData;
  nodes: TreeNode[];
  edges: LayoutEdge[];
  contentWidth: number;
  contentHeight: number;
}

interface SectionsInput {
  milestoneOrder: Array<{ id: string | null; name: string }>;
  msIssuesMap: Map<string | null, ScheduledIssue[]>;
  parentsOf: Map<string, string[]>;
  summaries: Map<string | null, MilestoneSummaryData>;
}

function buildSections(schedule: ScheduleResult): SectionsInput {
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
  { milestoneOrder, msIssuesMap, parentsOf, summaries }: SectionsInput,
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

/** Layout the dependency tree using ELK. Returns a promise of milestone sections. */
export function layoutDependencyTree(schedule: ScheduleResult): Promise<MilestoneSection[]> {
  return layoutWithElk(schedule, buildSections(schedule));
}

/** SVG path for an ELK-routed edge (with quadratic bezier smoothing at bends). */
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
  const x1 = edge.from.x + NODE_WIDTH / 2;
  const y1 = edge.from.y + NODE_HEIGHT;
  const x2 = edge.to.x + NODE_WIDTH / 2;
  const y2 = edge.to.y;
  const cy1 = y1 + (y2 - y1) * 0.35;
  const cy2 = y2 - (y2 - y1) * 0.35;
  return `M${x1} ${y1} C${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
}
