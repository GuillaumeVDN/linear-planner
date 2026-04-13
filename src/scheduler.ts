import type { LinearIssue, LinearCycle, LinearMilestone, LinearWorkflowState } from "./linear";

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
  assigneeName: string | null; // 0-1 for "started" type, 0 for backlog/unstarted, 1 for completed
  daysSpent: number | null; // working days from startedAt to today (started/done), null if not started
  hasEstimate: boolean;
  done: boolean;
  blockedBy: Array<{ identifier: string; title: string; done: boolean }>;
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

// --- French public holidays ---

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function frenchHolidays(year: number): Set<string> {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (d: Date, n: number) => {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  };
  const easter = easterSunday(year);
  return new Set(
    [
      new Date(year, 0, 1), // New Year
      new Date(year, 4, 1), // Labour Day
      new Date(year, 4, 8), // Victory in Europe
      new Date(year, 6, 14), // Bastille Day
      new Date(year, 7, 15), // Assumption
      new Date(year, 10, 1), // All Saints
      new Date(year, 10, 11), // Armistice
      new Date(year, 11, 25), // Christmas
      addDays(easter, 1), // Easter Monday
      addDays(easter, 39), // Ascension Thursday
      addDays(easter, 50), // Whit Monday
    ].map(fmt),
  );
}

const holidayCache = new Map<number, Set<string>>();
function isHolidayDate(date: Date): boolean {
  const year = date.getFullYear();
  if (!holidayCache.has(year)) holidayCache.set(year, frenchHolidays(year));
  const key = `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return holidayCache.get(year)!.has(key);
}

/** Exported for use by the chart to gray out non-working day columns */
export function isNonWorkingDay(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6 || isHolidayDate(date);
}

/** Check if a date is a bank holiday (weekday holiday, not a weekend) */
export function isBankHoliday(date: Date): boolean {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6 && isHolidayDate(date);
}

// --- Working day calendar ---

function buildWorkingDayCalendar(startDate: Date, maxCalendarDays: number) {
  const workingDays: number[] = [];
  const calendarToWd: number[] = [];

  for (let d = 0; d < maxCalendarDays; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    if (!isNonWorkingDay(date)) {
      calendarToWd.push(workingDays.length);
      workingDays.push(d);
    } else {
      calendarToWd.push(-1);
    }
  }

  return {
    toCalendar(wdIndex: number): number {
      if (wdIndex < workingDays.length) return workingDays[wdIndex];
      let d = workingDays.length > 0 ? workingDays[workingDays.length - 1] + 1 : 0;
      let idx = workingDays.length;
      while (idx <= wdIndex) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + d);
        if (!isNonWorkingDay(date)) {
          if (idx === wdIndex) return d;
          idx++;
        }
        d++;
      }
      return d;
    },
    /** Convert calendar day offset to working day index (next wd if non-working) */
    toWorkingDay(calendarDay: number): number {
      if (calendarDay >= 0 && calendarDay < calendarToWd.length) {
        const wd = calendarToWd[calendarDay];
        if (wd >= 0) return wd;
      }
      // Find next working day
      let d = Math.max(calendarDay, 0);
      while (d < calendarToWd.length) {
        if (calendarToWd[d] >= 0) return calendarToWd[d];
        d++;
      }
      return workingDays.length;
    },
    workingDays,
    calendarToWd,
  };
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DEFAULT_ESTIMATE = 3;

/**
 * Build a function that checks if an issue is effectively done.
 * Done = completed/canceled state type, OR "started" type with position >= "merged" position.
 */
function buildIsDone(issues: LinearIssue[], workflowStates: LinearWorkflowState[], endStatusName: string): (issue: LinearIssue) => boolean {
  // Find the position of the end status within the "started" type
  let endPosition: number | null = null;

  // First try exact name match from configured end status
  if (endStatusName) {
    for (const state of workflowStates) {
      if (state.type === "started" && state.name === endStatusName) {
        if (endPosition === null || state.position < endPosition) {
          endPosition = state.position;
        }
      }
    }
  }

  // Fallback: look for "merged" in workflow states
  if (endPosition === null) {
    for (const state of workflowStates) {
      if (state.type === "started" && state.name.toLowerCase().includes("merged")) {
        if (endPosition === null || state.position < endPosition) {
          endPosition = state.position;
        }
      }
    }
  }

  // Fallback: derive from issues
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

function dateToCalendarOffset(date: Date, startDate: Date): number {
  return Math.round((date.getTime() - startDate.getTime()) / MS_PER_DAY);
}

/**
 * Build a schedulable-day calendar that skips cooldown periods.
 *
 * schedulableDays[si] = working day index of the si-th schedulable day.
 *
 * If no cycles are provided, all working days are schedulable.
 * If cycles are provided, only working days within a cycle are schedulable.
 * Working days past the last known cycle are also schedulable (we can't predict future cycles).
 */
function buildSchedulableDays(
  cal: ReturnType<typeof buildWorkingDayCalendar>,
  linearCycles: LinearCycle[],
  startDate: Date,
) {
  if (linearCycles.length === 0) {
    // No cycles — every working day is schedulable
    return {
      toWorkingDay(si: number) { return si; },
      toSchedulable(wdIndex: number) { return wdIndex; },
    };
  }

  // Convert cycles to working-day ranges [startWd, endWd) — inclusive of cycle dates
  const cycleWdRanges: Array<{ startWd: number; endWd: number }> = [];
  for (const c of linearCycles) {
    const cStart = new Date(c.startsAt);
    cStart.setHours(0, 0, 0, 0);
    const cEnd = new Date(c.endsAt);
    cEnd.setHours(0, 0, 0, 0);
    const startCal = dateToCalendarOffset(cStart, startDate);
    const endCal = dateToCalendarOffset(cEnd, startDate);
    const startWd = cal.toWorkingDay(startCal);
    // endWd: first working day on or after the cycle end date (exclusive)
    const endWd = cal.toWorkingDay(endCal);
    if (endWd > startWd) cycleWdRanges.push({ startWd, endWd });
  }

  // Find the last known cycle end
  const lastCycleEndWd = cycleWdRanges.length > 0
    ? Math.max(...cycleWdRanges.map((r) => r.endWd))
    : 0;

  // Check if a working day is inside any cycle
  function isInCycle(wdIndex: number): boolean {
    // Past last known cycle — allow scheduling (we don't know future cycles)
    if (wdIndex >= lastCycleEndWd) return true;
    for (const r of cycleWdRanges) {
      if (wdIndex >= r.startWd && wdIndex < r.endWd) return true;
    }
    return false;
  }

  // Build forward mapping: schedulable index → working day index
  const schedulable: number[] = [];
  // And reverse: working day index → schedulable index (or -1 if cooldown)
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
      // Beyond precomputed: past last cycle, every working day is schedulable
      const overflow = si - schedulable.length;
      return (schedulable.length > 0 ? schedulable[schedulable.length - 1] + 1 : 0) + overflow;
    },
    /** Convert working day index to schedulable index (next schedulable if in cooldown) */
    toSchedulable(wdIndex: number): number {
      if (wdIndex < wdToSchedulable.length) {
        const si = wdToSchedulable[wdIndex];
        if (si >= 0) return si;
      }
      // Find next schedulable day
      let wd = Math.max(wdIndex, 0);
      while (wd < wdToSchedulable.length) {
        if (wdToSchedulable[wd] >= 0) return wdToSchedulable[wd];
        wd++;
      }
      // Past precomputed range
      return schedulable.length + (wd - (schedulable.length > 0 ? schedulable[schedulable.length - 1] + 1 : 0));
    },
  };
}

export function scheduleIssues(
  issues: LinearIssue[],
  numWorkers: number,
  startDate: Date,
  linearCycles: LinearCycle[] = [],
  projectMilestones: LinearMilestone[] = [],
  workflowStates: LinearWorkflowState[] = [],
  endStatusName: string = "",
  doneEndDates: Map<string, string> = new Map(),
): ScheduleResult {
  const cal = buildWorkingDayCalendar(startDate, 730);
  const sched = buildSchedulableDays(cal, linearCycles, startDate);
  const issueMap = new Map(issues.map((i) => [i.id, i]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayWd = cal.toWorkingDay(dateToCalendarOffset(today, startDate));
  const todaySi = sched.toSchedulable(todayWd);

  // Compute progress for "started" states from the full workflow state list
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

  // Count downstream dependents for priority
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

  // --- Scheduling state (non-done issues only) ---
  const scheduled: ScheduledIssue[] = [];
  const endSiMap = new Map<string, number>();
  const scheduledIds = new Set<string>();

  function buildScheduledIssue(issue: LinearIssue, duration: number, estimate: number, startSi: number, endSi: number, worker: number): ScheduledIssue {
    const hasEstimate = issue.estimate != null && issue.estimate > 0;
    let daysSpent: number | null = null;
    if (issue.startedAt) {
      if (isDone(issue)) {
        // Done issues: actual working days = their computed duration
        daysSpent = duration;
      } else {
        // In-progress issues: working days from startedAt to today
        const startedDate = new Date(issue.startedAt);
        startedDate.setHours(0, 0, 0, 0);
        const startedWd = cal.toWorkingDay(dateToCalendarOffset(startedDate, startDate));
        daysSpent = Math.max(1, todayWd - startedWd + 1);
      }
    }
    return {
      id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url,
      duration, estimate,
      startDay: cal.toCalendar(sched.toWorkingDay(startSi)),
      endDay: cal.toCalendar(sched.toWorkingDay(endSi - 1)) + 1,
      worker, milestone: issue.projectMilestone,
      stateName: issue.state.name, stateType: issue.state.type, stateColor: issue.state.color, stateProgress: getStateProgress(issue),
      priority: issue.priority, priorityLabel: issue.priorityLabel,
      assigneeAvatarUrl: issue.assignee?.avatarUrl ?? null, assigneeName: issue.assignee?.name ?? null,
      daysSpent, hasEstimate, done: isDone(issue),
      blockedBy: Array.from(allBlockedBy.get(issue.id) ?? [])
        .map((id) => { const b = issueMap.get(id); return b ? { identifier: b.identifier, title: b.title, done: isDone(b) } : null; })
        .filter((x): x is { identifier: string; title: string; done: boolean } => !!x),
    };
  }

  // --- Pre-populate done issues in dependency maps (so non-done issues see their blockers as resolved) ---
  for (const issue of issues) {
    if (!isDone(issue) || !issue.startedAt) continue;
    scheduledIds.add(issue.id);
    const d = new Date(issue.startedAt);
    d.setHours(0, 0, 0, 0);
    const startWd = cal.toWorkingDay(dateToCalendarOffset(d, startDate));
    const startSi = sched.toSchedulable(startWd);
    const endDateStr = doneEndDates.get(issue.id) ?? issue.completedAt;
    const hasEst = issue.estimate != null && issue.estimate > 0;
    const baseDur = hasEst ? issue.estimate! : DEFAULT_ESTIMATE;
    let endSi: number;
    if (endDateStr) {
      const endDate = new Date(endDateStr);
      endDate.setHours(0, 0, 0, 0);
      endSi = startSi + Math.max(1, cal.toWorkingDay(dateToCalendarOffset(endDate, startDate)) - startWd + 1);
    } else {
      endSi = startSi + Math.max(1, Math.min(baseDur, todayWd - startWd + 1));
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
      workerFreeAtSi[bestWorker] = endSi;
      endSiMap.set(issue.id, endSi);
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

    // Helper: get ready issues (all blockers scheduled) and their earliest start
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
        // Unstarted issues (e.g. "To do") can't be scheduled before today
        if (issue.state.type === "unstarted" || issue.state.type === "backlog" || issue.state.type === "triage") {
          earliest = Math.max(earliest, todaySi);
        }
        if (earliest <= atTime) {
          result.push({ issue, earliestSi: earliest });
        }
      }
      // Sort: most downstream dependents first, then by identifier
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
      // Find the used worker freed soonest
      let bestUsedW = -1;
      let bestUsedFree = Infinity;
      for (let w = 0; w < effectiveNumWorkers; w++) {
        if (workerFreeAtSi[w] > 0 && workerFreeAtSi[w] < bestUsedFree) {
          bestUsedFree = workerFreeAtSi[w];
          bestUsedW = w;
        }
      }

      // Try to assign work to the earliest-free used worker
      if (bestUsedW >= 0) {
        const ready = getReadyIssues(bestUsedFree);
        if (ready.length > 0) {
          // Check if ANY ready issue could start earlier on an unused worker
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

      // No used worker has ready work — check if unused workers could help
      const allReady = getReadyIssues(Infinity);
      if (allReady.length === 0) break;

      const nextReadySi = allReady[0].earliestSi;
      // Check if any used worker is free at or before nextReadySi
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

      // No used worker can handle it
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

      // Advance the earliest used worker to the next event
      if (bestUsedW >= 0) {
        const nextEvent = Math.min(
          ...Array.from(msRemaining).map((id) => {
            let earliest = milestoneBarrier;
            for (const bid of blockedBy.get(id) ?? []) {
              earliest = Math.max(earliest, endSiMap.get(bid) ?? Infinity);
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

    // Update milestone barrier
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
  // Done issues are not scheduled to workers — they just show actual dates.
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

  // Pack done issues into display lanes by overlap
  const doneLaneIntervals: Array<Array<[number, number]>> = [];
  for (const di of doneItems) {
    let lane = doneLaneIntervals.findIndex((intervals) => !intervals.some(([s, e]) => di.startDay < e && di.endDay > s));
    if (lane < 0) { lane = doneLaneIntervals.length; doneLaneIntervals.push([]); }
    doneLaneIntervals[lane].push([di.startDay, di.endDay]);
    di.worker = lane;
  }
  const numDoneLanes = doneLaneIntervals.length;

  // Offset non-done worker rows below done lanes, sort each group by earliest start
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

  // Merge done items into result
  const allIssues = [...doneItems, ...scheduled];

  const usedWorkers = scheduled.length > 0 ? Math.max(...scheduled.map((s) => s.worker)) - numDoneLanes + 1 : 1;
  let totalDays = Math.max(...allIssues.map((s) => s.endDay), 0);
  const todayOffset = dateToCalendarOffset(today, startDate);

  // Milestone boundaries
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

  // Cycle periods
  const cycles: CyclePeriod[] = linearCycles
    .map((c) => {
      const cStart = new Date(c.startsAt); cStart.setHours(0, 0, 0, 0);
      const cEnd = new Date(c.endsAt); cEnd.setHours(0, 0, 0, 0);
      return { label: c.name || `Cycle ${c.number}`, startDay: dateToCalendarOffset(cStart, startDate), endDay: dateToCalendarOffset(cEnd, startDate) };
    })
    .filter((c) => c.endDay > 0);
  for (const c of cycles) totalDays = Math.max(totalDays, c.endDay);

  const milestones: MilestoneInfo[] = [...projectMilestones].sort((a, b) => a.sortOrder - b.sortOrder);

  return { issues: allIssues, milestones, usedWorkers, totalDays, startDate, todayOffset, iterations, cycles };
}

/** Convert a day offset to a Date */
export function dayToDate(startDate: Date, dayOffset: number): Date {
  const d = new Date(startDate);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

/** Format a date as "Mon DD" */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
