import { getAccessToken } from "./auth";

const LINEAR_API = "https://api.linear.app/graphql";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  estimate: number | null;
  priority: number;
  priorityLabel: string;
  startedAt: string | null;
  completedAt: string | null;
  state: { name: string; type: string; color: string; position: number };
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  projectMilestone: { id: string; name: string; sortOrder: number } | null;
  labels: { nodes: Array<{ name: string; color: string }> };
  relations: {
    nodes: Array<{
      id: string;
      type: string;
      relatedIssue: { id: string; identifier: string };
    }>;
  };
}

export interface LinearProject {
  id: string;
  name: string;
}

export interface LinearMilestone {
  id: string;
  name: string;
  sortOrder: number;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  color: string;
}

export interface LinearCycle {
  id: string;
  name: string | null;
  number: number;
  startsAt: string;
  endsAt: string;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Linear API error ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e: { message: string }) => e.message).join(", "));
  return json.data;
}

export async function fetchProjects(): Promise<LinearProject[]> {
  const allProjects: LinearProject[] = [];
  let hasMore = true;
  let cursor: string | undefined;

  while (hasMore) {
    const data = await gql<{
      projects: {
        nodes: LinearProject[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    }>(
      `
      query($after: String) {
        projects(first: 250, after: $after, orderBy: updatedAt) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
      { after: cursor }
    );

    allProjects.push(...data.projects.nodes);
    hasMore = data.projects.pageInfo.hasNextPage;
    cursor = data.projects.pageInfo.endCursor;
  }

  return allProjects;
}

export async function fetchProjectMilestones(projectId: string): Promise<LinearMilestone[]> {
  const data = await gql<{
    project: { projectMilestones: { nodes: LinearMilestone[] } };
  }>(
    `
    query($projectId: String!) {
      project(id: $projectId) {
        projectMilestones { nodes { id name sortOrder } }
      }
    }
  `,
    { projectId }
  );
  return data.project.projectMilestones.nodes;
}

async function fetchTeamWorkflowStates(teamId: string): Promise<LinearWorkflowState[]> {
  const data = await gql<{
    team: { states: { nodes: LinearWorkflowState[] } };
  }>(
    `
    query($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type position color } }
      }
    }
  `,
    { teamId },
  );
  return data.team.states.nodes;
}

export async function fetchProjectWorkflowStates(projectId: string): Promise<LinearWorkflowState[]> {
  const teamIds = await fetchProjectTeamIds(projectId);
  const allStates: LinearWorkflowState[] = [];
  for (const teamId of teamIds) {
    allStates.push(...await fetchTeamWorkflowStates(teamId));
  }
  const seen = new Set<string>();
  return allStates
    .filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; })
    .sort((a, b) => a.position - b.position);
}

export async function fetchProjectTeamIds(projectId: string): Promise<string[]> {
  const data = await gql<{
    project: { teams: { nodes: Array<{ id: string }> } };
  }>(
    `
    query($projectId: String!) {
      project(id: $projectId) {
        teams { nodes { id } }
      }
    }
  `,
    { projectId }
  );
  return data.project.teams.nodes.map((t) => t.id);
}

export async function fetchTeamCycles(teamId: string): Promise<LinearCycle[]> {
  const allCycles: LinearCycle[] = [];
  let hasMore = true;
  let cursor: string | undefined;

  while (hasMore) {
    const data = await gql<{
      team: {
        cycles: {
          nodes: LinearCycle[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      };
    }>(
      `
      query($teamId: String!, $after: String) {
        team(id: $teamId) {
          cycles(first: 50, after: $after) {
            nodes {
              id
              name
              number
              startsAt
              endsAt
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `,
      { teamId, after: cursor }
    );

    allCycles.push(...data.team.cycles.nodes);
    hasMore = data.team.cycles.pageInfo.hasNextPage;
    cursor = data.team.cycles.pageInfo.endCursor;
  }

  return allCycles;
}

export async function fetchProjectCycles(projectId: string): Promise<LinearCycle[]> {
  const teamIds = await fetchProjectTeamIds(projectId);
  const allCycles: LinearCycle[] = [];
  for (const teamId of teamIds) {
    const cycles = await fetchTeamCycles(teamId);
    allCycles.push(...cycles);
  }
  // Deduplicate by id and sort by start date
  const seen = new Set<string>();
  return allCycles
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

export async function fetchProjectIssues(projectId: string): Promise<LinearIssue[]> {
  // Use small page size to stay under Linear's query complexity limit (10000)
  // Nested relations + cycle multiplies complexity per issue
  const allIssues: LinearIssue[] = [];
  let hasMore = true;
  let cursor: string | undefined;

  while (hasMore) {
    const data = await gql<{
      project: {
        issues: {
          nodes: LinearIssue[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        };
      };
    }>(
      `
      query($projectId: String!, $after: String) {
        project(id: $projectId) {
          issues(first: 20, after: $after) {
            nodes {
              id
              identifier
              title
              url
              estimate
              priority
              priorityLabel
              startedAt
              completedAt
              assignee { id name avatarUrl }
              state { name type color position }
              projectMilestone { id name sortOrder }
              labels { nodes { name color } }
              relations {
                nodes {
                  id
                  type
                  relatedIssue { id identifier }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `,
      { projectId, after: cursor }
    );

    allIssues.push(...data.project.issues.nodes);
    hasMore = data.project.issues.pageInfo.hasNextPage;
    cursor = data.project.issues.pageInfo.endCursor;
  }

  return allIssues.filter(isPlannableIssue);
}

/**
 * Issues tagged `no-planner`, or sitting in a "Duplicate" workflow state, are
 * excluded from the planner entirely.
 */
export function isPlannableIssue(issue: Pick<LinearIssue, "labels" | "state">): boolean {
  if (issue.labels.nodes.some((l) => l.name === "no-planner")) return false;
  if (issue.state.name === "Duplicate") return false;
  return true;
}

/**
 * Optimistically add a "blocks" relation to local issue data, mirroring what a refetch would
 * produce. A "blocks" relation lives on the *blocker* issue with `relatedIssue` pointing at the
 * blocked one (see the scheduler). Returns a new array; the blocker issue is duplicated with the
 * extra relation node, everything else is returned as-is. A duplicate relation is a no-op.
 */
export function addBlocksRelation(
  issues: LinearIssue[],
  blockerId: string,
  blockedId: string,
  relationId: string,
): LinearIssue[] {
  const identifier = issues.find((i) => i.id === blockedId)?.identifier ?? "";
  return issues.map((issue) => {
    if (issue.id !== blockerId) return issue;
    if (issue.relations.nodes.some((r) => r.type === "blocks" && r.relatedIssue.id === blockedId)) return issue;
    return {
      ...issue,
      relations: {
        ...issue.relations,
        nodes: [...issue.relations.nodes, { id: relationId, type: "blocks", relatedIssue: { id: blockedId, identifier } }],
      },
    };
  });
}

/**
 * Optimistically drop an IssueRelation from local issue data by id. The node lives on whichever
 * issue holds it, so it's filtered out everywhere. Only issues that actually held it are copied.
 */
export function removeRelation(issues: LinearIssue[], relationId: string): LinearIssue[] {
  return issues.map((issue) =>
    issue.relations.nodes.some((r) => r.id === relationId)
      ? { ...issue, relations: { ...issue.relations, nodes: issue.relations.nodes.filter((r) => r.id !== relationId) } }
      : issue,
  );
}

/**
 * Delete a single IssueRelation by id. Requires the `write` OAuth scope.
 */
export async function deleteIssueRelation(relationId: string): Promise<void> {
  await gql<{ issueRelationDelete: { success: boolean } }>(
    `
    mutation IssueRelationDelete($id: String!) {
      issueRelationDelete(id: $id) {
        success
      }
    }
  `,
    { id: relationId },
  );
}

/**
 * Create a "blocks" relation: `blockerId` blocks `blockedId`. Requires the `write` OAuth scope.
 * Returns the new IssueRelation id so callers can patch local state (and later delete it)
 * without refetching.
 */
export async function createBlockingRelation(blockerId: string, blockedId: string): Promise<string> {
  // `type` is an `IssueRelationType` enum — must be a bare identifier, not a quoted string.
  const data = await gql<{ issueRelationCreate: { success: boolean; issueRelation: { id: string } } }>(
    `
    mutation IssueRelationCreate($issueId: String!, $relatedIssueId: String!) {
      issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) {
        success
        issueRelation { id }
      }
    }
  `,
    { issueId: blockerId, relatedIssueId: blockedId },
  );
  return data.issueRelationCreate.issueRelation.id;
}

export interface StateTransition {
  createdAt: string;
  fromState: { name: string; type: string; position: number } | null;
  toState: { name: string; type: string; position: number } | null;
}

/** A time window during which the issue had *some* assignee. `endIso === null` = still assigned now. */
export interface AssignedInterval {
  startIso: string;
  endIso: string | null;
}

/** Sentinel for an assigned interval that was already open before the recorded history begins. */
export const ASSIGNED_SINCE_BEGINNING = "0000-01-01T00:00:00.000Z";

/**
 * A manual "don't count these days" correction, entered as a Linear comment:
 *   planner-no-count: 2026-06-10-AM, 2026-06-12-PM
 * Both endpoints are inclusive (so the example excludes Jun 10 AM through Jun 12 PM).
 */
export interface NoCountRange {
  startDate: string; // "YYYY-MM-DD"
  startPm: boolean;
  endDate: string;
  endPm: boolean;
}

const NO_COUNT_TOKEN = /(\d{4}-\d{2}-\d{2})-(AM|PM)/gi;

/** Parse every `planner-no-count:` directive out of a comment body into half-day ranges. */
export function parseNoCountRanges(body: string): NoCountRange[] {
  const ranges: NoCountRange[] = [];
  for (const line of body.split(/\r?\n/)) {
    const idx = line.toLowerCase().indexOf("planner-no-count:");
    if (idx === -1) continue;
    const rest = line.slice(idx + "planner-no-count:".length);
    const tokens = [...rest.matchAll(NO_COUNT_TOKEN)].map((m) => ({ date: m[1], pm: m[2].toUpperCase() === "PM" }));
    // Tokens come in (start, end) pairs; ignore a dangling token.
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      ranges.push({ startDate: tokens[i].date, startPm: tokens[i].pm, endDate: tokens[i + 1].date, endPm: tokens[i + 1].pm });
    }
  }
  return ranges;
}

export interface IssueHistory {
  /** State changes only, chronological. */
  transitions: Map<string, StateTransition[]>;
  /** Periods each issue had an assignee, chronological. Empty/absent ⇒ assignee never changed. */
  assignedIntervals: Map<string, AssignedInterval[]>;
  /** Manual day-exclusion ranges parsed from `planner-no-count:` comments. */
  noCount: Map<string, NoCountRange[]>;
}

type AssigneeRef = { id: string } | null;

/** Build the "had an assignee" intervals from an issue's chronological history nodes. */
function buildAssignedIntervals(
  nodes: Array<{ createdAt: string; fromAssignee: AssigneeRef; toAssignee: AssigneeRef }>,
): AssignedInterval[] {
  // Only nodes that actually change the assignee matter (state-only changes report null/null).
  const events = nodes.filter((n) => (n.fromAssignee?.id ?? null) !== (n.toAssignee?.id ?? null));
  if (events.length === 0) return []; // assignee never changed → caller treats as "always as-is"

  const intervals: AssignedInterval[] = [];
  // State before the very first change tells us whether the issue started out assigned.
  let assigned = events[0].fromAssignee != null;
  let openStart: string | null = assigned ? ASSIGNED_SINCE_BEGINNING : null;
  for (const e of events) {
    const nowAssigned = e.toAssignee != null;
    if (!assigned && nowAssigned) {
      openStart = e.createdAt;
    } else if (assigned && !nowAssigned) {
      intervals.push({ startIso: openStart ?? ASSIGNED_SINCE_BEGINNING, endIso: e.createdAt });
      openStart = null;
    }
    assigned = nowAssigned;
  }
  if (assigned) intervals.push({ startIso: openStart ?? ASSIGNED_SINCE_BEGINNING, endIso: null });
  return intervals;
}

/**
 * Fetch the full state-transition history for a set of issues, including the position
 * of both the previous and next state. Used to accurately account for time spent in
 * each workflow state (so a ticket that bounces in and out of "In Progress" doesn't
 * accrue spurious days while it sat in "Waiting for info"). Also returns, per issue, the
 * windows during which it had an assignee — time with nobody assigned isn't counted as work.
 */
export async function fetchIssueStateHistory(issueIds: string[]): Promise<IssueHistory> {
  const transitions = new Map<string, StateTransition[]>();
  const assignedIntervals = new Map<string, AssignedInterval[]>();
  const noCount = new Map<string, NoCountRange[]>();
  if (issueIds.length === 0) return { transitions, assignedIntervals, noCount };

  for (let i = 0; i < issueIds.length; i += 5) {
    const batch = issueIds.slice(i, i + 5);
    const params = batch.map((_, idx) => `$id${idx}: String!`).join(", ");
    const aliases = batch
      .map(
        (_, idx) =>
          `i${idx}: issue(id: $id${idx}) { id history(first: 100) { nodes { createdAt fromState { name type position } toState { name type position } fromAssignee { id } toAssignee { id } } } comments(first: 100) { nodes { body } } }`,
      )
      .join("\n");

    const variables: Record<string, unknown> = {};
    batch.forEach((id, idx) => { variables[`id${idx}`] = id; });

    const data = await gql<
      Record<string, {
        id: string;
        history: { nodes: Array<{ createdAt: string; fromState: StateTransition["fromState"]; toState: StateTransition["toState"]; fromAssignee: AssigneeRef; toAssignee: AssigneeRef }> };
        comments: { nodes: Array<{ body: string }> };
      }>
    >(`query(${params}) { ${aliases} }`, variables);

    for (const key of Object.keys(data)) {
      const issue = data[key];
      if (!issue) continue;
      // Linear returns history newest-first — flip so callers can iterate chronologically.
      const chronological = [...(issue.history?.nodes ?? [])].reverse();
      const stateTransitions = chronological
        .filter((n) => n.toState || n.fromState)
        .map((n) => ({ createdAt: n.createdAt, fromState: n.fromState, toState: n.toState }));
      transitions.set(issue.id, stateTransitions);
      assignedIntervals.set(issue.id, buildAssignedIntervals(chronological));
      const ranges = (issue.comments?.nodes ?? []).flatMap((c) => parseNoCountRanges(c.body));
      if (ranges.length > 0) noCount.set(issue.id, ranges);
    }
  }

  return { transitions, assignedIntervals, noCount };
}

/**
 * Fetch the date each issue entered a specific workflow state, by querying issue history.
 * Returns a map of issueId -> ISO date string.
 */
export async function fetchIssueEndDates(
  issueIds: string[],
  endStateName: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (issueIds.length === 0 || !endStateName) return result;

  for (let i = 0; i < issueIds.length; i += 5) {
    const batch = issueIds.slice(i, i + 5);
    const params = batch.map((_, idx) => `$id${idx}: String!`).join(", ");
    const aliases = batch
      .map((_, idx) => `i${idx}: issue(id: $id${idx}) { id history(first: 50) { nodes { createdAt toState { name } } } }`)
      .join("\n");

    const variables: Record<string, unknown> = {};
    batch.forEach((id, idx) => { variables[`id${idx}`] = id; });

    const data = await gql<Record<string, { id: string; history: { nodes: Array<{ createdAt: string; toState: { name: string } | null }> } }>>(
      `query(${params}) { ${aliases} }`,
      variables,
    );

    for (const key of Object.keys(data)) {
      const issue = data[key];
      if (!issue?.history?.nodes) continue;
      // History is newest-first; first match = most recent transition to end state
      for (const entry of issue.history.nodes) {
        if (entry.toState?.name === endStateName) {
          result.set(issue.id, entry.createdAt);
          break;
        }
      }
    }
  }

  return result;
}
