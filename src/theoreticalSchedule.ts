// Given a set of issues with estimates and dependencies, compute the wall-clock
// working-days it WOULD take to complete them with W parallel workers,
// ignoring their real Linear start/end dates.
//
// Used to compare against actual elapsed wall-clock so we can tell when a team
// achieved more parallelism than estimated (ahead) or less (behind).

export interface TheoreticalIssue {
  id: string;
  estimate: number; // in working days
  blockedBy: string[]; // ids of other TheoreticalIssue (deps outside the set are ignored)
}

/**
 * Greedy list-scheduler: at each step, assign the ready issue with the earliest possible
 * start time to the worker that frees up soonest. Respects dependencies. Returns the
 * wall-clock working-day count when the last issue finishes.
 */
export function theoreticalSchedule(issues: TheoreticalIssue[], workers: number): number {
  if (issues.length === 0) return 0;
  const W = Math.max(1, workers);
  const issueMap = new Map(issues.map((i) => [i.id, i]));
  const idSet = new Set(issues.map((i) => i.id));
  const endByIssue = new Map<string, number>();
  const workerFreeAt = new Array(W).fill(0);
  const remaining = new Set(issues.map((i) => i.id));

  // Guard against pathological inputs (cycles) — bound by total issue count.
  let safety = issues.length * (W + 2) + 10;
  while (remaining.size > 0 && safety-- > 0) {
    const ready: Array<{ issue: TheoreticalIssue; earliestStart: number }> = [];
    for (const id of remaining) {
      const issue = issueMap.get(id)!;
      const deps = issue.blockedBy.filter((d) => idSet.has(d));
      if (!deps.every((d) => endByIssue.has(d))) continue;
      const earliestStart = deps.reduce((m, d) => Math.max(m, endByIssue.get(d)!), 0);
      ready.push({ issue, earliestStart });
    }
    if (ready.length === 0) break; // cycle or unresolvable

    // Schedule earliest-ready first; tiebreak by larger estimate (longest first heuristic).
    ready.sort((a, b) => a.earliestStart - b.earliestStart || b.issue.estimate - a.issue.estimate);
    const { issue, earliestStart } = ready[0];

    // Pick the worker that can start this issue soonest.
    let bestWorker = 0;
    let bestStart = Infinity;
    for (let w = 0; w < W; w++) {
      const start = Math.max(workerFreeAt[w], earliestStart);
      if (start < bestStart) { bestStart = start; bestWorker = w; }
    }
    const end = bestStart + issue.estimate;
    workerFreeAt[bestWorker] = end;
    endByIssue.set(issue.id, end);
    remaining.delete(issue.id);
  }

  let max = 0;
  for (const v of endByIssue.values()) if (v > max) max = v;
  return max;
}
