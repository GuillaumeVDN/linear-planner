import type { LinearIssue, LinearCycle, LinearMilestone, LinearWorkflowState } from "./linear";
import { buildWorkingDayCalendar, dateToCalendarOffset, halfDayAdjustment } from "./workingDays";

export interface ScheduledIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  duration: number; // working days (actual for done issues, estimated for others)
  estimate: number; // planned working days from issue estimate
  startDay: number; // 0-based calendar day offset from chart start
  endDay: number; // exclusive calendar day offset
  worker: number;
  milestone: { id: string; name: string; sortOrder: number } | null;
  stateName: string;
  stateType: string;
  stateColor: string;
  stateProgress: number;
  priority: number;
  priorityLabel: string;
  assigneeAvatarUrl: string | null;
  assigneeName: string | null;
  daysSpent: number | null; // working days from startedAt to today (started/done), null if not started
  hasEstimate: boolean;
  done: boolean;
  isLate: boolean; // in-progress and has taken more working days than estimated
  blockedBy: Array<{ identifier: string; title: string; done: boolean }>;
  startedAtRaw: string | null;
  endedAtRaw: string | null;
  labels: Array<{ name: string; color: string }>;
}

export interface CyclePeriod {
  label: string;
  startDay: number;
  endDay: number;
}

export interface MilestoneInfo {
  id: string;
  name: string;
  sortOrder: number;
}

export interface ScheduleResult {
  issues: ScheduledIssue[];
  milestones: MilestoneInfo[];
  usedWorkers: number;
  totalDays: number;
  startDate: Date;
  todayOffset: number;
  iterations: Array<{ name: string; endDay: number }>;
  cycles: CyclePeriod[];
}

const DEFAULT_ESTIMATE = 3;

/**
 * Build a function that checks if an issue is effectively done.
 * Done = completed/canceled state type, OR "started" type with position >= "merged" position.
 */
function buildIsDone(issues: LinearIssue[], workflowStates: LinearWorkflowState[], endStatusName: string): (issue: LinearIssue) => boolean {
  let endPosition: number | null = null;

  if (endStatusName) {
    for (const state of workflowStates) {
      if (state.type === "started" && state.name === endStatusName) {
        if (endPosition === null || state.position < endPosition) {
          endPosition = state.position;
        }
      }
    }
  }

  if (endPosition === null) {
    for (const state of workflowStates) {
      if (state.type === "started" && state.name.toLowerCase().includes("merged")) {
        if (endPosition === null || state.position < endPosition) {
          endPosition = state.position;
        }
      }
    }
  }

  if (endPosition === null) {
    for (const issue of issues) {
      if (issue.state.type === "started" && issue.state.name.toLowerCase().includes("merged")) {
        if (endPosition === null || issue.state.position < endPosition) {
          endPosition = issue.state.position;
        }
      }
    }
  }

  return (issue: LinearIssue): boolean => {
    const t = issue.state.type;
    if (t === "completed" || t === "canceled") return true;
    if (t === "started" && endPosition !== null && issue.state.position >= endPosition) return true;
    return false;
  };
}

/**
 * Build a schedulable-day calendar that skips cooldown periods.
 *
 * If no cycles are provided, all working days are schedulable.
 * If cycles are provided, only working days within a cycle are schedulable.
 * Working days past the last known cycle are also schedulable.
 */
function buildSchedulableDays(
  cal: ReturnType<typeof buildWorkingDayCalendar>,
  linearCycles: LinearCycle[],
  startDate: Date,
) {
  if (linearCycles.length === 0) {
    return {
      toWorkingDay(si: number) { return si; },
      toSchedulable(wdIndex: number) { return wdIndex; },
      countSchedulable(startWd: number, endWd: number) { return endWd < startWd ? 0 : endWd - startWd + 1; },
    };
  }

  const cycleWdRanges: Array<{ startWd: number; endWd: number }> = [];
  for (const c of linearCycles) {
    const cStart = new Date(c.startsAt);
    cStart.setHours(0, 0, 0, 0);
    const cEnd = new Date(c.endsAt);
    cEnd.setHours(0, 0, 0, 0);
    const startCal = dateToCalendarOffset(cStart, startDate);
    const endCal = dateToCalendarOffset(cEnd, startDate);
    const startWd = cal.toWorkingDay(startCal);
    const endWd = cal.toWorkingDay(endCal);
    if (endWd > startWd) cycleWdRanges.push({ startWd, endWd });
  }

  const lastCycleEndWd = cycleWdRanges.length > 0
    ? Math.max(...cycleWdRanges.map((r) => r.endWd))
    : 0;

  function isInCycle(wdIndex: number): boolean {
    if (wdIndex >= lastCycleEndWd) return true;
    for (const r of cycleWdRanges) {
      if (wdIndex >= r.startWd && wdIndex < r.endWd) return true;
    }
    return false;
  }

  const schedulable: number[] = [];
  const wdToSchedulable: number[] = [];

  const maxWd = Math.max(lastCycleEndWd + 500, cal.workingDays.length);
  for (let wd = 0; wd < maxWd; wd++) {
    if (isInCycle(wd)) {
      wdToSchedulable.push(schedulable.length);
      schedulable.push(wd);
    } else {
      wdToSchedulable.push(-1);
    }
  }

  return {
    toWorkingDay(si: number): number {
      if (si < schedulable.length) return schedulable[si];
      const overflow = si - schedulable.length;
      return (schedulable.length > 0 ? schedulable[schedulable.length - 1] + 1 : 0) + overflow;
    },
    /** Convert working day index to schedulable index (next schedulable if in cooldown) */
    toSchedulable(wdIndex: number): number {
      if (wdIndex < wdToSchedulable.length) {
        const si = wdToSchedulable[wdIndex];
        if (si >= 0) return si;
      }
      let wd = Math.max(wdIndex, 0);
      while (wd < wdToSchedulable.length) {
        if (wdToSchedulable[wd] >= 0) return wdToSchedulable[wd];
        wd++;
      }
      return schedulable.length + (wd - (schedulable.length > 0 ? schedulable[schedulable.length - 1] + 1 : 0));
    },
    /** Count schedulable days in the inclusive working-day range [startWd, endWd]. Cooldown days excluded. */
    countSchedulable(startWd: number, endWd: number): number {
      if (endWd < startWd) return 0;
      let count = 0;
      for (let wd = startWd; wd <= endWd; wd++) {
        if (wd >= 0 && wd < wdToSchedulable.length) {
          if (wdToSchedulable[wd] >= 0) count++;
        } else if (wd >= wdToSchedulable.length) {
          count++;
        }
      }
      return count;
    },
  };
}

/**
 * Append virtual cycles past the last real one (same duration & cooldown as the last real pair),
 * so the scheduler can place issues beyond the configured cycles while still honoring cooldown gaps.
 */
function extendCyclesWithVirtual(linearCycles: LinearCycle[]): { cycles: LinearCycle[]; realIds: Set<string> } {
  const realIds = new Set(linearCycles.map((c) => c.id));
  if (linearCycles.length === 0) return { cycles: linearCycles, realIds };
  // Chronologically-last cycle defines duration and cooldown gap.
  const sorted = [...linearCycles].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  const last = sorted[sorted.length - 1];
  const secondLast = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
  const cycleMs = new Date(last.endsAt).getTime() - new Date(last.startsAt).getTime();
  const cooldownMs = secondLast
    ? Math.max(0, new Date(last.startsAt).getTime() - new Date(secondLast.endsAt).getTime())
    : 0;
  // Linear's `number` field is the cycle's internal per-team index (1/2/3/4) — NOT the visible
  // "Cycle 36" suffix in the name. So derive the displayed number from the name's trailing digits.
  function labelNumberOf(c: LinearCycle): number {
    const label = c.name ?? `Cycle ${c.number}`;
    const m = label.match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : c.number;
  }
  const byLabelNumber = [...linearCycles].sort((a, b) => labelNumberOf(b) - labelNumberOf(a));
  const numberRef = byLabelNumber[0];
  const baseNumber = labelNumberOf(numberRef);
  const refLabel = numberRef.name ?? `Cycle ${numberRef.number}`;
  const labelMatch = refLabel.match(/^(.*?)(\d+)\s*$/);
  const prefix = labelMatch ? labelMatch[1] : "Cycle ";
  const virtuals: LinearCycle[] = [];
  let nextStartMs = new Date(last.endsAt).getTime() + cooldownMs;
  for (let i = 1; i <= 100; i++) {
    virtuals.push({
      id: `virtual-${last.id}-${i}`,
      name: `${prefix}${baseNumber + i}`,
      number: baseNumber + i,
      startsAt: new Date(nextStartMs).toISOString(),
      endsAt: new Date(nextStartMs + cycleMs).toISOString(),
    });
    nextStartMs += cycleMs + cooldownMs;
  }
  return { cycles: [...linearCycles, ...virtuals], realIds };
}

export function scheduleIssues(
  issues: LinearIssue[],
  numWorkers: number,
  startDate: Date,
  linearCyclesInput: LinearCycle[] = [],
  projectMilestones: LinearMilestone[] = [],
  workflowStates: LinearWorkflowState[] = [],
  endStatusName: string = "",
  doneEndDates: Map<string, string> = new Map(),
): ScheduleResult {
  const { cycles: linearCycles, realIds: realCycleIds } = extendCyclesWithVirtual(linearCyclesInput);
  const cal = buildWorkingDayCalendar(startDate, 730);
  const sched = buildSchedulableDays(cal, linearCycles, startDate);
  const issueMap = new Map(issues.map((i) => [i.id, i]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayWd = cal.toWorkingDay(dateToCalendarOffset(today, startDate));
  const todaySi = sched.toSchedulable(todayWd);

  const startedStates = workflowStates
    .filter((s) => s.type === "started")
    .sort((a, b) => a.position - b.position);

  function getStateProgress(issue: LinearIssue): number {
    const t = issue.state.type;
    if (t === "completed" || t === "canceled") return 1;
    if (t !== "started" || startedStates.length === 0) return 0;
    const idx = startedStates.findIndex((s) => s.position === issue.state.position);
    if (idx < 0) return 0.5;
    return (idx + 1) / (startedStates.length + 1);
  }

  // Build dependency graphs:
  // - blockedBy: for scheduling (ignores done blockers)
  // - allBlockedBy: for display (all relations, including done blockers)
  const isDone = buildIsDone(issues, workflowStates, endStatusName);
  const blockedBy = new Map<string, Set<string>>();
  const allBlockedBy = new Map<string, Set<string>>();
  for (const issue of issues) {
    blockedBy.set(issue.id, new Set());
    allBlockedBy.set(issue.id, new Set());
  }
  for (const issue of issues) {
    for (const rel of issue.relations.nodes) {
      if (rel.type === "blocks") {
        const targetId = rel.relatedIssue.id;
        if (allBlockedBy.has(targetId)) allBlockedBy.get(targetId)!.add(issue.id);
        if (!isDone(issue) && blockedBy.has(targetId)) blockedBy.get(targetId)!.add(issue.id);
      }
    }
  }

  const downstream = new Map<string, number>();
  function countDownstream(id: string, visited: Set<string>): number {
    if (visited.has(id)) return 0;
    visited.add(id);
    if (downstream.has(id)) return downstream.get(id)!;
    let count = 0;
    for (const issue of issues) {
      if (blockedBy.get(issue.id)?.has(id)) {
        count += 1 + countDownstream(issue.id, visited);
      }
    }
    downstream.set(id, count);
    return count;
  }
  for (const issue of issues) countDownstream(issue.id, new Set());

  const scheduled: ScheduledIssue[] = [];
  const endSiMap = new Map<string, number>();
  const doneEndDateStr = new Map<string, string | null>();
  const scheduledIds = new Set<string>();

  function buildScheduledIssue(issue: LinearIssue, duration: number, estimate: number, startSi: number, endSi: number, worker: number): ScheduledIssue {
    const hasEstimate = issue.estimate != null && issue.estimate > 0;
    let daysSpent: number | null = null;
    if (issue.startedAt) {
      if (isDone(issue)) {
        daysSpent = Math.max(0.5, duration + halfDayAdjustment(issue.startedAt, doneEndDateStr.get(issue.id) ?? null));
      } else {
        const startedDate = new Date(issue.startedAt);
        startedDate.setHours(0, 0, 0, 0);
        const startedWd = cal.toWorkingDay(dateToCalendarOffset(startedDate, startDate));
        // Treat "now" as the end-of-period for half-day accounting: if it's still morning,
        // today only counts as half a working day.
        daysSpent = Math.max(0.5, sched.countSchedulable(startedWd, todayWd) + halfDayAdjustment(issue.startedAt, new Date().toISOString()));
      }
    }
    const isLate = !isDone(issue) && issue.startedAt != null && daysSpent != null && hasEstimate && daysSpent > estimate;
    let endDay = cal.toCalendar(sched.toWorkingDay(endSi - 1)) + 1;
    if (isLate) {
      endDay = Math.max(endDay, dateToCalendarOffset(today, startDate) + 1);
    }
    return {
      id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url,
      duration, estimate,
      startDay: cal.toCalendar(sched.toWorkingDay(startSi)),
      endDay,
      worker, milestone: issue.projectMilestone,
      stateName: issue.state.name, stateType: issue.state.type, stateColor: issue.state.color, stateProgress: getStateProgress(issue),
      priority: issue.priority, priorityLabel: issue.priorityLabel,
      assigneeAvatarUrl: issue.assignee?.avatarUrl ?? null, assigneeName: issue.assignee?.name ?? null,
      daysSpent, hasEstimate, done: isDone(issue), isLate,
      startedAtRaw: issue.startedAt, endedAtRaw: isDone(issue) ? (doneEndDateStr.get(issue.id) ?? null) : null,
      labels: issue.labels.nodes,
      blockedBy: Array.from(allBlockedBy.get(issue.id) ?? [])
        .map((id) => { const b = issueMap.get(id); return b ? { identifier: b.identifier, title: b.title, done: isDone(b) } : null; })
        .filter((x): x is { identifier: string; title: string; done: boolean } => !!x),
    };
  }

  // --- Pre-populate done issues so non-done issues see their blockers as resolved ---
  for (const issue of issues) {
    if (!isDone(issue) || !issue.startedAt) continue;
    scheduledIds.add(issue.id);
    const d = new Date(issue.startedAt);
    d.setHours(0, 0, 0, 0);
    const startWd = cal.toWorkingDay(dateToCalendarOffset(d, startDate));
    const startSi = sched.toSchedulable(startWd);
    const endDateStr = doneEndDates.get(issue.id) ?? issue.completedAt;
    doneEndDateStr.set(issue.id, endDateStr);
    const hasEst = issue.estimate != null && issue.estimate > 0;
    const baseDur = hasEst ? issue.estimate! : DEFAULT_ESTIMATE;
    let endSi: number;
    if (endDateStr) {
      const endDate = new Date(endDateStr);
      endDate.setHours(0, 0, 0, 0);
      const endWd = cal.toWorkingDay(dateToCalendarOffset(endDate, startDate));
      endSi = startSi + Math.max(1, sched.countSchedulable(startWd, endWd));
    } else {
      endSi = startSi + Math.max(1, Math.min(baseDur, sched.countSchedulable(startWd, todayWd)));
    }
    endSiMap.set(issue.id, endSi);
  }

  // --- Phase 1: pin non-done started issues to their startedAt ---
  const effectiveNumWorkers = Math.max(1, numWorkers);
  const workerFreeAtSi = new Array(effectiveNumWorkers).fill(0);

  const pinnedRemaining = new Set(
    issues.filter((i) => i.startedAt && !isDone(i)).map((i) => i.id),
  );

  let progress = true;
  while (progress && pinnedRemaining.size > 0) {
    progress = false;
    for (const issueId of pinnedRemaining) {
      const issue = issueMap.get(issueId)!;
      const undoneBlockers = Array.from(blockedBy.get(issueId) ?? []);
      if (!undoneBlockers.every((bid) => scheduledIds.has(bid))) continue;

      const d = new Date(issue.startedAt!);
      d.setHours(0, 0, 0, 0);
      const startWd = cal.toWorkingDay(dateToCalendarOffset(d, startDate));
      const desiredStartSi = sched.toSchedulable(startWd);
      const hasEstimate = issue.estimate != null && issue.estimate > 0;
      const est = hasEstimate ? issue.estimate! : DEFAULT_ESTIMATE;

      let earliestFromBlockers = 0;
      for (const bid of undoneBlockers) {
        earliestFromBlockers = Math.max(earliestFromBlockers, endSiMap.get(bid) ?? 0);
      }

      let bestWorker = 0;
      let bestStartSi = Infinity;
      const constrainedSi = Math.max(desiredStartSi, earliestFromBlockers);
      for (let w = 0; w < effectiveNumWorkers; w++) {
        const s = Math.max(workerFreeAtSi[w], constrainedSi);
        if (s < bestStartSi) { bestStartSi = s; bestWorker = w; }
      }

      const startSi = bestStartSi;
      const endSi = startSi + est;
      const isLate = hasEstimate && todaySi >= endSi;
      const effectiveEndSi = isLate ? todaySi + 1 : endSi;
      workerFreeAtSi[bestWorker] = effectiveEndSi;
      endSiMap.set(issue.id, effectiveEndSi);
      scheduledIds.add(issue.id);
      pinnedRemaining.delete(issueId);
      progress = true;
      scheduled.push(buildScheduledIssue(issue, est, est, startSi, endSi, bestWorker));
    }
  }

  // --- Phase 2: schedule remaining non-done issues per milestone ---
  const unpinned = issues.filter((i) => !scheduledIds.has(i.id) && !isDone(i));

  const unpinnedByMs = new Map<string | null, LinearIssue[]>();
  for (const issue of unpinned) {
    const msId = issue.projectMilestone?.id ?? null;
    if (!unpinnedByMs.has(msId)) unpinnedByMs.set(msId, []);
    unpinnedByMs.get(msId)!.push(issue);
  }

  const msOrder: Array<string | null> = [
    ...projectMilestones.sort((a, b) => a.sortOrder - b.sortOrder).map((m) => m.id),
    null,
  ];

  let milestoneBarrier = 0;

  function scheduleIssueOnWorker(issue: LinearIssue, worker: number, startSi: number) {
    const hasEstimate = issue.estimate != null && issue.estimate > 0;
    const est = hasEstimate ? issue.estimate! : DEFAULT_ESTIMATE;
    const endSi = startSi + est;

    workerFreeAtSi[worker] = endSi;
    endSiMap.set(issue.id, endSi);
    scheduledIds.add(issue.id);

    scheduled.push(buildScheduledIssue(issue, est, est, startSi, endSi, worker));
  }

  for (const msId of msOrder) {
    const msIssues = (unpinnedByMs.get(msId) ?? []);
    const msRemaining = new Set(msIssues.map((i) => i.id));

    function getReadyIssues(atTime: number): Array<{ issue: LinearIssue; earliestSi: number }> {
      const result: Array<{ issue: LinearIssue; earliestSi: number }> = [];
      for (const issue of msIssues) {
        if (!msRemaining.has(issue.id)) continue;
        const undoneDeps = Array.from(blockedBy.get(issue.id) ?? []);
        if (!undoneDeps.every((bid) => scheduledIds.has(bid))) continue;
        let earliest = milestoneBarrier;
        for (const bid of undoneDeps) {
          earliest = Math.max(earliest, endSiMap.get(bid) ?? 0);
        }
        if (issue.state.type === "unstarted" || issue.state.type === "backlog" || issue.state.type === "triage") {
          earliest = Math.max(earliest, todaySi);
        }
        if (earliest <= atTime) {
          result.push({ issue, earliestSi: earliest });
        }
      }
      result.sort((a, b) => {
        const da = downstream.get(a.issue.id) ?? 0;
        const db = downstream.get(b.issue.id) ?? 0;
        if (da !== db) return db - da;
        return a.issue.identifier.localeCompare(b.issue.identifier);
      });
      return result;
    }

    let safetyCounter = msIssues.length * effectiveNumWorkers + 100;
    while (msRemaining.size > 0 && safetyCounter-- > 0) {
      let bestUsedW = -1;
      let bestUsedFree = Infinity;
      for (let w = 0; w < effectiveNumWorkers; w++) {
        if (workerFreeAtSi[w] > 0 && workerFreeAtSi[w] < bestUsedFree) {
          bestUsedFree = workerFreeAtSi[w];
          bestUsedW = w;
        }
      }

      if (bestUsedW >= 0) {
        const ready = getReadyIssues(bestUsedFree);
        if (ready.length > 0) {
          const unusedW = workerFreeAtSi.findIndex((f) => f === 0);
          if (unusedW >= 0) {
            const earlyIssue = ready.reduce<(typeof ready)[0] | null>((best, r) =>
              r.earliestSi < bestUsedFree && (!best || r.earliestSi < best.earliestSi) ? r : best, null);
            if (earlyIssue) {
              scheduleIssueOnWorker(earlyIssue.issue, unusedW, earlyIssue.earliestSi);
              msRemaining.delete(earlyIssue.issue.id);
              continue;
            }
          }
          scheduleIssueOnWorker(ready[0].issue, bestUsedW, bestUsedFree);
          msRemaining.delete(ready[0].issue.id);
          continue;
        }
      }

      const allReady = getReadyIssues(Infinity);
      if (allReady.length === 0) break;

      const nextReadySi = allReady[0].earliestSi;
      let canUseExisting = false;
      for (let w = 0; w < effectiveNumWorkers; w++) {
        if (workerFreeAtSi[w] > 0 && workerFreeAtSi[w] <= nextReadySi) {
          const ready = getReadyIssues(workerFreeAtSi[w]);
          if (ready.length > 0) {
            scheduleIssueOnWorker(ready[0].issue, w, Math.max(workerFreeAtSi[w], ready[0].earliestSi));
            msRemaining.delete(ready[0].issue.id);
            canUseExisting = true;
            break;
          }
        }
      }
      if (canUseExisting) continue;

      const allUsedBusy = !Array.from({ length: effectiveNumWorkers }, (_, w) => w)
        .some((w) => workerFreeAtSi[w] > 0 && workerFreeAtSi[w] <= nextReadySi);

      if (allUsedBusy) {
        let newW = -1;
        let newFree = Infinity;
        for (let w = 0; w < effectiveNumWorkers; w++) {
          if (workerFreeAtSi[w] === 0) { newW = w; newFree = 0; break; }
          if (workerFreeAtSi[w] < newFree) { newFree = workerFreeAtSi[w]; newW = w; }
        }
        if (newW >= 0) {
          const startSi = Math.max(newFree, nextReadySi);
          scheduleIssueOnWorker(allReady[0].issue, newW, startSi);
          msRemaining.delete(allReady[0].issue.id);
          continue;
        }
      }

      if (bestUsedW >= 0) {
        const nextEvent = Math.min(
          ...Array.from(msRemaining).map((id) => {
            let earliest = milestoneBarrier;
            for (const bid of blockedBy.get(id) ?? []) {
              earliest = Math.max(earliest, endSiMap.get(bid) ?? Infinity);
            }
            const issue = issueMap.get(id);
            if (issue && (issue.state.type === "unstarted" || issue.state.type === "backlog" || issue.state.type === "triage")) {
              earliest = Math.max(earliest, todaySi);
            }
            return earliest;
          }).filter((t) => t > bestUsedFree),
          bestUsedFree + 1000,
        );
        workerFreeAtSi[bestUsedW] = nextEvent;
      } else {
        break;
      }
    }

    for (const issue of msIssues) {
      milestoneBarrier = Math.max(milestoneBarrier, endSiMap.get(issue.id) ?? 0);
    }
    for (const s of scheduled) {
      if ((s.milestone?.id ?? null) === msId) {
        milestoneBarrier = Math.max(milestoneBarrier, endSiMap.get(s.id) ?? 0);
      }
    }
  }

  // --- Post: add done issues as informational rows ---
  const doneItems: ScheduledIssue[] = [];
  for (const issue of issues) {
    if (!isDone(issue) || !issue.startedAt) continue;
    const d = new Date(issue.startedAt);
    d.setHours(0, 0, 0, 0);
    const startWd = cal.toWorkingDay(dateToCalendarOffset(d, startDate));
    const startSi = sched.toSchedulable(startWd);
    const endSi = endSiMap.get(issue.id) ?? startSi + 1;
    const hasEst = issue.estimate != null && issue.estimate > 0;
    const est = hasEst ? issue.estimate! : DEFAULT_ESTIMATE;
    doneItems.push(buildScheduledIssue(issue, endSi - startSi, est, startSi, endSi, -1));
  }

  // Pack done issues into display lanes by overlap.
  // Sort by startDay (tiebreak endDay) so first-fit is optimal — minimizes lanes.
  doneItems.sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay);
  const doneLaneIntervals: Array<Array<[number, number]>> = [];
  for (const di of doneItems) {
    let lane = doneLaneIntervals.findIndex((intervals) => !intervals.some(([s, e]) => di.startDay < e && di.endDay > s));
    if (lane < 0) { lane = doneLaneIntervals.length; doneLaneIntervals.push([]); }
    doneLaneIntervals[lane].push([di.startDay, di.endDay]);
    di.worker = lane;
  }
  const numDoneLanes = doneLaneIntervals.length;

  for (const s of scheduled) s.worker += numDoneLanes;

  function sortRowsByEarliestStart(items: ScheduledIssue[], offset: number) {
    const earliest = new Map<number, number>();
    for (const s of items) {
      const prev = earliest.get(s.worker);
      if (prev === undefined || s.startDay < prev) earliest.set(s.worker, s.startDay);
    }
    const remap = new Map<number, number>();
    Array.from(earliest.entries()).sort((a, b) => a[1] - b[1]).forEach(([oldW], i) => remap.set(oldW, offset + i));
    for (const s of items) s.worker = remap.get(s.worker) ?? s.worker;
  }

  sortRowsByEarliestStart(doneItems, 0);
  sortRowsByEarliestStart(scheduled, numDoneLanes);

  const allIssues = [...doneItems, ...scheduled];

  const usedWorkers = scheduled.length > 0 ? Math.max(...scheduled.map((s) => s.worker)) - numDoneLanes + 1 : 1;
  let totalDays = Math.max(...allIssues.map((s) => s.endDay), 0);
  const todayOffset = dateToCalendarOffset(today, startDate);

  const milestoneEndDays = new Map<string, { name: string; endDay: number }>();
  for (const s of allIssues) {
    if (s.milestone) {
      const existing = milestoneEndDays.get(s.milestone.id);
      if (!existing || s.endDay > existing.endDay) {
        milestoneEndDays.set(s.milestone.id, { name: s.milestone.name, endDay: s.endDay });
      }
    }
  }
  const iterations = Array.from(milestoneEndDays.values()).sort((a, b) => a.endDay - b.endDay);
  if (iterations.length > 0) iterations.pop();

  // Build display cycles from real + virtual cycles. Trim trailing virtual cycles
  // that aren't needed (i.e. start after the latest scheduled issue).
  const maxIssueEnd = Math.max(...allIssues.map((s) => s.endDay), 0);
  const cycles: CyclePeriod[] = [];
  for (const c of linearCycles) {
    const cStart = new Date(c.startsAt); cStart.setHours(0, 0, 0, 0);
    const cEnd = new Date(c.endsAt); cEnd.setHours(0, 0, 0, 0);
    const startDay = dateToCalendarOffset(cStart, startDate);
    const endDay = dateToCalendarOffset(cEnd, startDate);
    if (endDay <= 0) continue;
    const isReal = realCycleIds.has(c.id);
    if (!isReal && startDay > maxIssueEnd) break; // stop once virtual cycles are no longer needed
    cycles.push({ label: c.name || `Cycle ${c.number}`, startDay, endDay });
  }

  for (const c of cycles) totalDays = Math.max(totalDays, c.endDay);

  const milestones: MilestoneInfo[] = [...projectMilestones].sort((a, b) => a.sortOrder - b.sortOrder);

  return { issues: allIssues, milestones, usedWorkers, totalDays, startDate, todayOffset, iterations, cycles };
}
