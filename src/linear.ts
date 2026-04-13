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
  labels: { nodes: Array<{ name: string }> };
  relations: {
    nodes: Array<{
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

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
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

export async function fetchProjects(apiKey: string): Promise<LinearProject[]> {
  const data = await gql<{ projects: { nodes: LinearProject[] } }>(apiKey, `
    query {
      projects(first: 100, orderBy: updatedAt) {
        nodes { id name }
      }
    }
  `);
  return data.projects.nodes;
}

export async function fetchProjectMilestones(apiKey: string, projectId: string): Promise<LinearMilestone[]> {
  const data = await gql<{
    project: { projectMilestones: { nodes: LinearMilestone[] } };
  }>(
    apiKey,
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

async function fetchTeamWorkflowStates(apiKey: string, teamId: string): Promise<LinearWorkflowState[]> {
  const data = await gql<{
    team: { states: { nodes: LinearWorkflowState[] } };
  }>(
    apiKey,
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

export async function fetchProjectWorkflowStates(apiKey: string, projectId: string): Promise<LinearWorkflowState[]> {
  const teamIds = await fetchProjectTeamIds(apiKey, projectId);
  const allStates: LinearWorkflowState[] = [];
  for (const teamId of teamIds) {
    allStates.push(...await fetchTeamWorkflowStates(apiKey, teamId));
  }
  const seen = new Set<string>();
  return allStates
    .filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; })
    .sort((a, b) => a.position - b.position);
}

export async function fetchProjectTeamIds(apiKey: string, projectId: string): Promise<string[]> {
  const data = await gql<{
    project: { teams: { nodes: Array<{ id: string }> } };
  }>(
    apiKey,
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

export async function fetchTeamCycles(apiKey: string, teamId: string): Promise<LinearCycle[]> {
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
      apiKey,
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

export async function fetchProjectCycles(apiKey: string, projectId: string): Promise<LinearCycle[]> {
  const teamIds = await fetchProjectTeamIds(apiKey, projectId);
  const allCycles: LinearCycle[] = [];
  for (const teamId of teamIds) {
    const cycles = await fetchTeamCycles(apiKey, teamId);
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

export async function fetchProjectIssues(apiKey: string, projectId: string): Promise<LinearIssue[]> {
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
      apiKey,
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
              labels { nodes { name } }
              relations {
                nodes {
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

  return allIssues.filter(
    (issue) => !issue.labels.nodes.some((l) => l.name === "\u{1F680} DoD")
  );
}

/**
 * Fetch the date each issue entered a specific workflow state, by querying issue history.
 * Returns a map of issueId → ISO date string.
 */
export async function fetchIssueEndDates(
  apiKey: string,
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
      apiKey,
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
