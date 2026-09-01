import type { LinearIssue, LinearCycle, LinearMilestone, LinearWorkflowState, StateTransition, AssignedInterval, NoCountRange } from "./linear";
import { ASSIGNED_SINCE_BEGINNING } from "./linear";
import { buildWorkingDayCalendar, dateToCalendarOffset, halfDayAdjustment, isAfterThreshold } from "./workingDays";

/**
 * Internally the scheduler operates in HALF-DAY units. `si` (schedulable index) values
 * passed around between phases are *half-day* indices: even = AM of a working day, odd = PM.
 * Display values (`startDay`, `endDay`) are decimals with .0/.5 precision derived from these.
 */
const HALF_PER_DAY = 2;

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
  blockedBy: Array<{ id: string; identifier: string; title: string; done: boolean; relationId: string }>;
  startedAtRaw: string | null;
  endedAtRaw: string | null;
  labels: Array<{ name: string; color: string }>;
  /**
   * For in-progress issues whose state history is available: time spent in "started"-type
   * states whose position is below the configured start (e.g. "Waiting for info"), *after*
   * the issue first reached an active state. Surfaced in the card tooltip.
   */
  belowStartBreakdown: Array<{ stateName: string; days: number }>;
  /**
   * Half-day calendar ranges within the bar that were NOT counted as working time —
   * below-start states, unassigned stretches, or manual `planner-no-count:` corrections.
   * Rendered in the pending color over the in-progress bar. Fractional day offsets (.5 = PM).
   */
  ignoredRanges: Array<{ startDay: number; endDay: number }>;
  /** Manual day-exclusion ranges (working days) surfaced in the tooltip. */
  noCountDays: number;
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
  /** Number of worker lanes actually rendered in the gantt (may exceed configuredWorkers
   *  when more issues started in parallel than the configured capacity). */
  usedWorkers: number;
  /** The W the scheduler was called with — the user's configured parallelism cap. Use this
   *  (not usedWorkers) for theoretical-schedule comparisons in the milestone summary. */
  configuredWorkers: number;
  totalDays: number;
  startDate: Date;
  todayOffset: number;
  iterations: Array<{ name: string; endDay: number }>;
  cycles: CyclePeriod[];
}

const DEFAULT_ESTIMATE = 3;

/**
 * Order two issues the way they appear in our Linear views: priority first, then the
 * manual drag-and-drop order.
 *
 * Linear encodes priority as 0 = None, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low, and
 * displays "No priority" LAST — so 0 has to be pushed to the end rather than sorted as-is.
 * Within an equal priority, `sortOrder` ascending reproduces the list order.
 */
function compareLinearViewOrder(a: LinearIssue, b: LinearIssue): number {
  const pa = a.priority === 0 ? Number.MAX_SAFE_INTEGER : a.priority;
  const pb = b.priority === 0 ? Number.MAX_SAFE_INTEGER : b.priority;
  if (pa !== pb) return pa - pb;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.identifier.localeCompare(b.identifier);
}

/**
 * Build a function that checks if an issue is effectively done.
 * Done = completed/canceled state type, OR "started" type with position >= the configured end
 * status (falling back to a state named "merged" when nothing is configured).
 * Exported so callers decide "done" exactly the way the scheduler does — two copies of this
 * rule drifting apart is how a merged issue ends up both done and still-scheduled.
 */
export function buildIsDone(issues: LinearIssue[], workflowStates: LinearWorkflowState[], endStatusName: string): (issue: LinearIssue) => boolean {
  let endPosition: number | null = null;
  // Whether the configured end status exists in the workflow. When it does, it settles the
  // question — a *completed*-type end status (e.g. "Released") leaves no started position to
  // promote from, so only completed/canceled issues are done. Falling through to the "merged"
  // heuristic there would call an issue done that the user's own setting says is still open.
  let endStatusKnown = false;

  if (endStatusName) {
    for (const state of workflowStates) {
      if (state.name !== endStatusName) continue;
      endStatusKnown = true;
      if (state.type === "started" && (endPosition === null || state.position < endPosition)) {
        endPosition = state.position;
      }
    }
  }

  if (!endStatusKnown) {
    for (const state of workflowStates) {
      if (state.type === "started" && state.name.toLowerCase().includes("merged")) {
        if (endPosition === null || state.position < endPosition) {
          endPosition = state.position;
        }
      }
    }
  }

  if (!endStatusKnown && endPosition === null) {
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
      toSchedulableAtOrBefore(wdIndex: number) { return Math.max(wdIndex, 0); },
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
    /**
     * Convert working day index to schedulable index, snapping BACKWARDS out of a cooldown
     * (i.e. onto the last day of the preceding cycle) instead of forwards.
     *
     * Used for events that are already recorded — when a done issue actually started or was
     * merged. Snapping those forwards lands them on the first day of the *next* cycle, so a
     * ticket merged on the first day of a cooldown would end its bar two weeks later.
     */
    toSchedulableAtOrBefore(wdIndex: number): number {
      if (wdIndex >= wdToSchedulable.length) {
        // Past the table every working day is schedulable, so the offset carries over 1:1.
        const lastWd = wdToSchedulable.length - 1;
        return wdToSchedulable[lastWd] + (wdIndex - lastWd);
      }
      for (let wd = Math.max(wdIndex, 0); wd >= 0; wd--) {
        if (wdToSchedulable[wd] >= 0) return wdToSchedulable[wd];
      }
      return 0;
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
  startStatusName: string = "",
  stateHistoryByIssue: Map<string, StateTransition[]> = new Map(),
  assignedIntervalsByIssue: Map<string, AssignedInterval[]> = new Map(),
  noCountByIssue: Map<string, NoCountRange[]> = new Map(),
): ScheduleResult {
  const { cycles: linearCycles, realIds: realCycleIds } = extendCyclesWithVirtual(linearCyclesInput);
  const cal = buildWorkingDayCalendar(startDate, 730);
  const sched = buildSchedulableDays(cal, linearCycles, startDate);
  const issueMap = new Map(issues.map((i) => [i.id, i]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayWd = cal.toWorkingDay(dateToCalendarOffset(today, startDate));
  // si values used throughout are in half-day units (even=AM, odd=PM of a schedulable day).
  // "Today" is the first half-day at-or-after now.
  const todaySi = sched.toSchedulable(todayWd) * HALF_PER_DAY + (isAfterThreshold(new Date().toISOString()) ? 1 : 0);

  /** Round an estimate (in days) to the nearest half-day, ≥ 1 half. Used as work units in the packer. */
  function estimateToHalves(est: number): number {
    return Math.max(1, Math.round(est * HALF_PER_DAY));
  }

  /** Convert a half-day si index to a fractional calendar-day offset. .0 = AM, .5 = PM. */
  function siHalfToFractionalCalendar(siHalf: number): number {
    const wholeSi = Math.floor(siHalf / HALF_PER_DAY);
    const halfOffset = (siHalf % HALF_PER_DAY) * 0.5;
    return cal.toCalendar(sched.toWorkingDay(wholeSi)) + halfOffset;
  }

  /** Half-day si index for the morning of the working day containing the given ISO timestamp,
   *  shifted to PM if the time is after the 13:30 Paris threshold. */
  function siHalfForIso(iso: string): number {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    const wd = cal.toWorkingDay(dateToCalendarOffset(d, startDate));
    const baseSi = sched.toSchedulable(wd);
    return baseSi * HALF_PER_DAY + (isAfterThreshold(iso) ? 1 : 0);
  }

  /** Fractional calendar offset of the half-day a timestamp falls in: .0 = AM, .5 = PM.
   *  Unlike the si helpers this snaps nowhere — used to draw a done issue's bar on the days
   *  the work really happened, weekends and cooldowns included. */
  function calendarHalfForIso(iso: string): number {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    return dateToCalendarOffset(d, startDate) + (isAfterThreshold(iso) ? 0.5 : 0);
  }

  /** Half-day si index for an event that already happened (a done issue's start or merge):
   *  the last schedulable half at or before the timestamp. Non-working days and cooldowns snap
   *  BACKWARDS, unlike `siHalfForIso` — a ticket merged on the first day of a cooldown belongs
   *  at the end of the cycle it was worked in, not at the start of the next one. */
  function siHalfForIsoAtOrBefore(iso: string): number {
    const d = new Date(iso);
    d.setHours(0, 0, 0, 0);
    const calOffset = dateToCalendarOffset(d, startDate);
    let day = Math.min(calOffset, cal.calendarToWd.length - 1);
    while (day >= 0 && cal.calendarToWd[day] < 0) day--;
    if (day < 0) return 0;
    const wd = cal.calendarToWd[day];
    const si = sched.toSchedulableAtOrBefore(wd);
    // Landed on an earlier day than the event itself (weekend, holiday or cooldown): that day
    // was worked in full, so the range runs through its PM half.
    if (day !== calOffset || sched.toWorkingDay(si) !== wd) return si * HALF_PER_DAY + 1;
    return si * HALF_PER_DAY + (isAfterThreshold(iso) ? 1 : 0);
  }

  /** Calendar day offset of a manual "YYYY-MM-DD" date (used by no-count corrections). */
  function calendarOffsetForDate(dateStr: string): number {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, (m ?? 1) - 1, d ?? 1);
    date.setHours(0, 0, 0, 0);
    return dateToCalendarOffset(date, startDate);
  }

  /** Half-day si index for a manual "YYYY-MM-DD" date + AM/PM half. A non-working date snaps
   *  forward to the next working day (its AM), which is where an excluded stretch starts. */
  function siHalfForDateHalf(dateStr: string, pm: boolean): number {
    const wd = cal.toWorkingDay(calendarOffsetForDate(dateStr));
    return sched.toSchedulable(wd) * HALF_PER_DAY + (pm ? 1 : 0);
  }

  /** Exclusive si bound just past the last half a no-count range covers. A non-working end
   *  date (a weekend, typically) means "up to the weekend", so it snaps *backwards* onto the
   *  whole previous working day — snapping forward like the start does would exclude a
   *  half-day that comes after the range. */
  function siHalfAfterDateHalf(dateStr: string, pm: boolean): number {
    const calOffset = calendarOffsetForDate(dateStr);
    const isWorkingDay = calOffset >= 0 && calOffset < cal.calendarToWd.length && cal.calendarToWd[calOffset] >= 0;
    if (isWorkingDay) return siHalfForDateHalf(dateStr, pm) + 1;
    let d = Math.min(calOffset, cal.calendarToWd.length) - 1;
    while (d >= 0 && cal.calendarToWd[d] < 0) d--;
    if (d < 0) return 0;
    return (sched.toSchedulable(cal.calendarToWd[d]) + 1) * HALF_PER_DAY;
  }

  /** Predicate telling whether a half-day si index falls inside a `planner-no-count:` range
   *  (both endpoints inclusive). Shared by the in-progress sweep and the done-issue accounting. */
  function excludedHalfPredicate(noCount: NoCountRange[]): (h: number) => boolean {
    const windows = noCount.map((r) => ({
      lo: siHalfForDateHalf(r.startDate, r.startPm),
      hi: siHalfAfterDateHalf(r.endDate, r.endPm),
    }));
    return (h: number) => windows.some((w) => h >= w.lo && h < w.hi);
  }

  const startedStates = workflowStates
    .filter((s) => s.type === "started")
    .sort((a, b) => a.position - b.position);

  // Position at or above which an issue is considered "actively in progress".
  // If the user hasn't picked one, default to the lowest "started" position (= every started state).
  // Issues whose current state position is below this are treated as not yet in progress —
  // their startedAt is ignored for daysSpent and pinning. Use case: an issue moved into
  // "In Progress" then dropped back to "Waiting for info" (a started state below the configured
  // start) should not accrue working days while waiting.
  let startPosition: number | null = null;
  if (startStatusName) {
    const match = workflowStates.find((s) => s.name === startStatusName && s.type === "started");
    if (match) startPosition = match.position;
  }
  if (startPosition === null) {
    startPosition = startedStates.length > 0 ? startedStates[0].position : null;
  }
  function isActivelyInProgress(issue: LinearIssue): boolean {
    if (!issue.startedAt) return false;
    // An issue in a started state but with nobody assigned isn't really being worked on —
    // treat it like a not-started issue (no pinning, no accrued working days).
    if (!issue.assignee) return false;
    if (startPosition === null) return true; // no workflow info → fall back to legacy behaviour
    return issue.state.type === "started" && issue.state.position >= startPosition;
  }

  function getStateProgress(issue: LinearIssue): number {
    const t = issue.state.type;
    if (t === "completed" || t === "canceled") return 1;
    if (t !== "started" || startedStates.length === 0) return 0;
    const idx = startedStates.findIndex((s) => s.position === issue.state.position);
    if (idx < 0) return 0.5;
    return (idx + 1) / (startedStates.length + 1);
  }

  // Milestone scheduling order: Linear's milestone order, then the no-milestone bucket.
  // Milestones seen only on issues (not in `projectMilestones`) are folded in by their own
  // sortOrder — otherwise their issues land in a bucket phase 2 never visits and vanish.
  const msSortOrder = new Map<string, number>();
  for (const m of projectMilestones) msSortOrder.set(m.id, m.sortOrder);
  for (const issue of issues) {
    const m = issue.projectMilestone;
    if (m && !msSortOrder.has(m.id)) msSortOrder.set(m.id, m.sortOrder);
  }
  const msOrder: Array<string | null> = [
    ...Array.from(msSortOrder.entries()).sort((a, b) => a[1] - b[1]).map(([id]) => id),
    null,
  ];
  const msRank = new Map<string | null, number>();
  msOrder.forEach((id, i) => msRank.set(id, i));
  const rankOf = (issue: LinearIssue) => msRank.get(issue.projectMilestone?.id ?? null) ?? msOrder.length - 1;

  // Build dependency graphs:
  // - blockedBy: for scheduling (ignores done blockers)
  // - allBlockedBy: for display (all relations, including done blockers)
  const isDone = buildIsDone(issues, workflowStates, endStatusName);
  const blockedBy = new Map<string, Set<string>>();
  const allBlockedBy = new Map<string, Set<string>>();
  // (blockedId, blockerId) → Linear IssueRelation.id, so we can delete the relation later.
  const relationIdByPair = new Map<string, string>();
  const pairKey = (blockedId: string, blockerId: string) => `${blockedId}|${blockerId}`;
  for (const issue of issues) {
    blockedBy.set(issue.id, new Set());
    allBlockedBy.set(issue.id, new Set());
  }
  for (const issue of issues) {
    for (const rel of issue.relations.nodes) {
      if (rel.type !== "blocks") continue;
      const targetId = rel.relatedIssue.id;
      if (allBlockedBy.has(targetId)) allBlockedBy.get(targetId)!.add(issue.id);
      relationIdByPair.set(pairKey(targetId, issue.id), rel.id);
      if (isDone(issue) || !blockedBy.has(targetId)) continue;
      // Milestones are scheduled one after another behind a hard barrier, so a blocker sitting
      // in a LATER milestone can never be satisfied in time. Keep the relation for display, but
      // leave it out of the scheduling graph — otherwise the blocked issue never becomes ready
      // and drops out of the plan entirely.
      const target = issueMap.get(targetId);
      if (target && rankOf(issue) > rankOf(target)) continue;
      blockedBy.get(targetId)!.add(issue.id);
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

  /** Index of the first transition into an "active" state (type `started`, position ≥ the
   *  configured start). -1 when the issue never reached one. */
  function firstActiveTransitionIndex(transitions: StateTransition[]): number {
    if (startPosition === null) return -1;
    for (let i = 0; i < transitions.length; i++) {
      const ts = transitions[i].toState;
      if (ts && ts.type === "started" && ts.position >= startPosition) return i;
    }
    return -1;
  }

  /**
   * Walk a state-transition history and account for time per state.
   * Returns:
   *   - effectiveStartedAtIso: ISO timestamp of the FIRST transition into an active state
   *     (type === "started" AND position >= startPosition). null if the issue never reached one.
   *   - activeDays: total schedulable working days the issue spent in active states from
   *     the effective start onwards.
   *   - belowStart: per below-start-state breakdown (only states encountered AFTER the
   *     first active entry).
   *
   * Uses segment-level halfDayAdjustment to be consistent with the rest of the scheduler.
   */
  function computeStateAccounting(transitions: StateTransition[], endIso: string, assignedIntervals: AssignedInterval[] = [], noCount: NoCountRange[] = []): {
    effectiveStartedAtIso: string;
    activeDays: number;
    belowStart: Array<{ stateName: string; days: number }>;
    ignoredHalfRanges: Array<[number, number]>;
    noCountHalves: number;
  } | null {
    if (startPosition === null) return null;
    const sp = startPosition;
    const firstActiveIdx = firstActiveTransitionIndex(transitions);
    if (firstActiveIdx === -1) return null;
    const effectiveStartedAtIso = transitions[firstActiveIdx].createdAt;

    // Assigned windows in half-day space. Empty list ⇒ assignee never changed, so every half
    // is treated as assigned (a single unbounded window), preserving the no-history behaviour.
    const assignedWindows = assignedIntervals.length > 0
      ? assignedIntervals.map((iv) => ({
          startHalf: iv.startIso === ASSIGNED_SINCE_BEGINNING ? -Infinity : siHalfForIso(iv.startIso),
          endHalf: iv.endIso === null ? Infinity : siHalfForIso(iv.endIso),
        }))
      : [{ startHalf: -Infinity, endHalf: Infinity }];
    const isAssignedHalf = (h: number) => assignedWindows.some((w) => h >= w.startHalf && h < w.endHalf);

    // Manual no-count corrections in half-day space; both endpoints inclusive.
    const isExcludedHalf = excludedHalfPredicate(noCount);

    // Sweep each half-day from the effective start to "now". A half counts as worked only when
    // its state is active (≥ start), someone is assigned, and it isn't manually excluded.
    // Everything else inside the bar is "ignored" and surfaced (visually + in the tooltip).
    let activeHalves = 0;
    let noCountHalves = 0;
    const belowStartByStateHalves = new Map<string, number>();
    const ignoredHalfRanges: Array<[number, number]> = [];
    const pushIgnored = (h: number) => {
      const last = ignoredHalfRanges[ignoredHalfRanges.length - 1];
      if (last && last[1] === h) last[1] = h + 1;
      else ignoredHalfRanges.push([h, h + 1]);
    };

    for (let i = firstActiveIdx; i < transitions.length; i++) {
      const segStartIso = transitions[i].createdAt;
      const isLastSeg = i + 1 >= transitions.length;
      const segEndIso = isLastSeg ? endIso : transitions[i + 1].createdAt;
      if (segEndIso <= segStartIso) continue;
      const state = transitions[i].toState;
      if (!state) continue;
      const startHalf = siHalfForIso(segStartIso);
      const endHalf = isLastSeg ? siHalfForIso(segEndIso) + 1 : siHalfForIso(segEndIso);
      const isActiveState = state.type === "started" && state.position >= sp;
      const isBelowStart = state.type === "started" && state.position < sp;

      if (isBelowStart) {
        belowStartByStateHalves.set(state.name, (belowStartByStateHalves.get(state.name) ?? 0) + Math.max(0, endHalf - startHalf));
      }

      for (let h = startHalf; h < endHalf; h++) {
        if (isActiveState && isAssignedHalf(h) && !isExcludedHalf(h)) {
          activeHalves++;
        } else {
          if (isActiveState && isExcludedHalf(h)) noCountHalves++;
          pushIgnored(h);
        }
      }
    }

    return {
      effectiveStartedAtIso,
      activeDays: activeHalves / HALF_PER_DAY,
      ignoredHalfRanges,
      noCountHalves,
      belowStart: Array.from(belowStartByStateHalves.entries()).map(([stateName, halves]) => ({ stateName, days: halves / HALF_PER_DAY })),
    };
  }

  // Precompute per-issue accounting once, so Phase 1 pinning AND buildScheduledIssue share
  // the SAME "effective started" timestamp. Without this, the card's `startDay` would still
  // come from Linear's startedAt (e.g. June 3, when the issue first hit any started state)
  // while `startedAtRaw` would show the corrected effective start (e.g. June 12).
  const accountingByIssue = new Map<string, { effectiveStartedAtIso: string; activeDays: number; belowStart: Array<{ stateName: string; days: number }>; ignoredHalfRanges: Array<[number, number]>; noCountHalves: number }>();
  for (const issue of issues) {
    if (!issue.startedAt || isDone(issue) || !isActivelyInProgress(issue)) continue;
    const history = stateHistoryByIssue.get(issue.id);
    if (!history || history.length === 0) continue;
    const acct = computeStateAccounting(history, new Date().toISOString(), assignedIntervalsByIssue.get(issue.id) ?? [], noCountByIssue.get(issue.id) ?? []);
    if (acct) accountingByIssue.set(issue.id, acct);
  }
  // Done issues keep their span-based days spent, but their bar must still start where the
  // work actually started: an issue parked in a below-start state (e.g. "Waiting for info")
  // for weeks before reaching "In progress" would otherwise stretch back to Linear's
  // `startedAt`, counting all that waiting as work.
  const doneEffectiveStart = new Map<string, string>();
  for (const issue of issues) {
    if (!issue.startedAt || !isDone(issue)) continue;
    const history = stateHistoryByIssue.get(issue.id);
    if (!history || history.length === 0) continue;
    const idx = firstActiveTransitionIndex(history);
    if (idx >= 0) doneEffectiveStart.set(issue.id, history[idx].createdAt);
  }

  function effectiveStartedAtFor(issue: LinearIssue): string {
    return accountingByIssue.get(issue.id)?.effectiveStartedAtIso
      ?? doneEffectiveStart.get(issue.id)
      ?? issue.startedAt!;
  }

  function buildScheduledIssue(issue: LinearIssue, duration: number, estimate: number, startSi: number, endSi: number, worker: number): ScheduledIssue {
    const hasEstimate = issue.estimate != null && issue.estimate > 0;
    let daysSpent: number | null = null;
    let belowStartBreakdown: Array<{ stateName: string; days: number }> = [];
    let effectiveStartedAtRaw = issue.startedAt;
    // Done issues get no state sweep (their bar spans real start→completion dates), so their
    // no-count exclusions are collected here instead of in `accountingByIssue`.
    const doneIgnoredHalfRanges: Array<[number, number]> = [];
    let doneNoCountHalves = 0;
    if (issue.startedAt) {
      if (isDone(issue)) {
        // si values already encode AM/PM positioning of start/end times — no extra adjustment
        // needed. Half-days manually excluded via `planner-no-count:` still drop out.
        effectiveStartedAtRaw = effectiveStartedAtFor(issue);
        const isExcludedHalf = excludedHalfPredicate(noCountByIssue.get(issue.id) ?? []);
        for (let h = startSi; h < endSi; h++) {
          if (!isExcludedHalf(h)) continue;
          doneNoCountHalves++;
          const last = doneIgnoredHalfRanges[doneIgnoredHalfRanges.length - 1];
          if (last && last[1] === h) last[1] = h + 1;
          else doneIgnoredHalfRanges.push([h, h + 1]);
        }
        daysSpent = Math.max(0.5, (endSi - startSi - doneNoCountHalves) / HALF_PER_DAY);
      } else if (isActivelyInProgress(issue)) {
        const acct = accountingByIssue.get(issue.id);
        if (acct) {
          daysSpent = Math.max(0.5, acct.activeDays);
          belowStartBreakdown = acct.belowStart;
          effectiveStartedAtRaw = acct.effectiveStartedAtIso;
        } else {
          // Fallback: no state history — use Linear's startedAt directly.
          const startedDate = new Date(issue.startedAt);
          startedDate.setHours(0, 0, 0, 0);
          const startedWd = cal.toWorkingDay(dateToCalendarOffset(startedDate, startDate));
          daysSpent = Math.max(0.5, sched.countSchedulable(startedWd, todayWd) + halfDayAdjustment(issue.startedAt, new Date().toISOString()));
        }
      }
      // else: issue is in a "started" state below the configured start status — leave daysSpent null.
    }
    const isLate = !isDone(issue) && issue.startedAt != null && daysSpent != null && hasEstimate && daysSpent > estimate;
    // startSi/endSi are in half-day units → convert to decimal calendar offsets (.0=AM, .5=PM).
    // endSi is EXCLUSIVE; derive the bar end from the last *worked* half (endSi - 1) plus its
    // half-width. Using siHalfToFractionalCalendar(endSi) directly would map the next schedulable
    // slot — which, right before a cooldown/holiday gap, lands in the *next* cycle and visually
    // stretches the bar across the gap.
    // A done issue is drawn on the dates it was actually worked, not on the schedulable grid:
    // a ticket merged during a cooldown (or over a weekend) must keep that real date rather
    // than being pushed onto a theoretical cycle day. Its si span still drives scheduling and
    // days spent, which stay counted in schedulable half-days.
    const doneEndIso = isDone(issue) ? doneEndDateStr.get(issue.id) : null;
    const startDay = isDone(issue) ? calendarHalfForIso(effectiveStartedAtRaw ?? issue.startedAt!) : siHalfToFractionalCalendar(startSi);
    let endDay = doneEndIso
      ? Math.max(calendarHalfForIso(doneEndIso) + 0.5, startDay + 0.5)
      : endSi > startSi ? siHalfToFractionalCalendar(endSi - 1) + 0.5 : siHalfToFractionalCalendar(endSi);
    if (isLate) {
      endDay = Math.max(endDay, dateToCalendarOffset(today, startDate) + 1);
    }
    // Convert the half-day "ignored" ranges (below-start / unassigned / no-count) to fractional
    // calendar offsets and clip them to the rendered bar so the gantt can paint them as pending.
    const acct = accountingByIssue.get(issue.id);
    const ignoredHalfRanges = isDone(issue) ? doneIgnoredHalfRanges : (acct?.ignoredHalfRanges ?? []);
    const ignoredRanges = ignoredHalfRanges
      .map(([lo, hi]) => ({ startDay: Math.max(startDay, siHalfToFractionalCalendar(lo)), endDay: Math.min(endDay, siHalfToFractionalCalendar(hi)) }))
      .filter((r) => r.endDay > r.startDay);
    const noCountDays = (isDone(issue) ? doneNoCountHalves : (acct?.noCountHalves ?? 0)) / HALF_PER_DAY;
    return {
      id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url,
      duration, estimate,
      startDay,
      endDay,
      worker, milestone: issue.projectMilestone,
      stateName: issue.state.name, stateType: issue.state.type, stateColor: issue.state.color, stateProgress: getStateProgress(issue),
      priority: issue.priority, priorityLabel: issue.priorityLabel,
      assigneeAvatarUrl: issue.assignee?.avatarUrl ?? null, assigneeName: issue.assignee?.name ?? null,
      daysSpent, hasEstimate, done: isDone(issue), isLate,
      startedAtRaw: effectiveStartedAtRaw,
      endedAtRaw: isDone(issue) ? (doneEndDateStr.get(issue.id) ?? null) : null,
      labels: issue.labels.nodes,
      belowStartBreakdown,
      ignoredRanges,
      noCountDays,
      blockedBy: Array.from(allBlockedBy.get(issue.id) ?? [])
        .map((bid) => {
          const b = issueMap.get(bid);
          if (!b) return null;
          return {
            id: b.id,
            identifier: b.identifier,
            title: b.title,
            done: isDone(b),
            relationId: relationIdByPair.get(pairKey(issue.id, bid)) ?? "",
          };
        })
        .filter((x): x is { id: string; identifier: string; title: string; done: boolean; relationId: string } => !!x),
    };
  }

  // --- Pre-populate done issues so non-done issues see their blockers as resolved ---
  for (const issue of issues) {
    if (!isDone(issue) || !issue.startedAt) continue;
    scheduledIds.add(issue.id);
    // siHalf: start at the morning of the start day, shifted to PM if started after 13:30.
    const startSi = siHalfForIsoAtOrBefore(effectiveStartedAtFor(issue));
    const endDateStr = doneEndDates.get(issue.id) ?? issue.completedAt;
    doneEndDateStr.set(issue.id, endDateStr);
    const hasEst = issue.estimate != null && issue.estimate > 0;
    const baseDur = hasEst ? issue.estimate! : DEFAULT_ESTIMATE;
    let endSi: number;
    if (endDateStr) {
      // End at the morning of the end day by default, or PM if ended after 13:30.
      // We add 1 (one half-day) so the half-day containing the end is included in the bar.
      const endHalfRaw = siHalfForIsoAtOrBefore(endDateStr);
      endSi = Math.max(startSi + 1, endHalfRaw + 1);
    } else {
      // No explicit end date: fall back to estimate-bounded duration up to today.
      const startWdForCount = Math.floor(startSi / HALF_PER_DAY);
      const cappedHalves = Math.max(1, Math.min(estimateToHalves(baseDur), sched.countSchedulable(startWdForCount, todayWd) * HALF_PER_DAY));
      endSi = startSi + cappedHalves;
    }
    endSiMap.set(issue.id, endSi);
  }

  // --- Phase 1: pin non-done started issues to their startedAt ---
  // The user configures W workers, but reality sometimes has more issues started in
  // parallel than W. To honor each issue's real start date, we may grow workerFreeAtSi
  // beyond W here. Phase 2 only ever uses the first W slots for scheduling new work.
  const configuredNumWorkers = Math.max(1, numWorkers);
  const workerFreeAtSi: number[] = new Array(configuredNumWorkers).fill(0);

  const pinnedRemaining = new Set(
    issues.filter((i) => isActivelyInProgress(i) && !isDone(i)).map((i) => i.id),
  );

  let progress = true;
  while (progress && pinnedRemaining.size > 0) {
    progress = false;
    for (const issueId of pinnedRemaining) {
      const issue = issueMap.get(issueId)!;
      const undoneBlockers = Array.from(blockedBy.get(issueId) ?? []);
      if (!undoneBlockers.every((bid) => scheduledIds.has(bid))) continue;

      // Use the effective started timestamp (first entry into an active state) when state
      // history is available, so the gantt bar starts where the work actually started — not
      // at Linear's `startedAt`, which can be much earlier (e.g. moved to "Waiting for info"
      // for days before reaching "In progress").
      const effectiveStartedIso = effectiveStartedAtFor(issue) ?? issue.startedAt!;
      // Half-day desired start: AM of the effective day, or PM if started after 13:30 Paris.
      const desiredStartSi = siHalfForIso(effectiveStartedIso);
      const hasEstimate = issue.estimate != null && issue.estimate > 0;
      const est = hasEstimate ? issue.estimate! : DEFAULT_ESTIMATE;
      const estHalves = estimateToHalves(est);

      let earliestFromBlockers = 0;
      for (const bid of undoneBlockers) {
        earliestFromBlockers = Math.max(earliestFromBlockers, endSiMap.get(bid) ?? 0);
      }

      let bestWorker = -1;
      let bestStartSi = Infinity;
      const constrainedSi = Math.max(desiredStartSi, earliestFromBlockers);
      for (let w = 0; w < workerFreeAtSi.length; w++) {
        const s = Math.max(workerFreeAtSi[w], constrainedSi);
        if (s < bestStartSi) { bestStartSi = s; bestWorker = w; }
      }
      // If no existing worker can start the issue at its actual desired start, spawn a new
      // worker lane so the issue renders at the correct real Linear date.
      if (bestStartSi > constrainedSi) {
        bestWorker = workerFreeAtSi.length;
        workerFreeAtSi.push(0);
        bestStartSi = constrainedSi;
      }

      const startSi = bestStartSi;
      const endSi = startSi + estHalves;
      const isLate = hasEstimate && todaySi >= endSi;
      // When late, extend the bar to cover today fully (end of PM of today).
      const effectiveEndSi = isLate ? (Math.floor(todaySi / HALF_PER_DAY) + 1) * HALF_PER_DAY : endSi;
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

  let milestoneBarrier = 0;

  function scheduleIssueOnWorker(issue: LinearIssue, worker: number, startSi: number) {
    const hasEstimate = issue.estimate != null && issue.estimate > 0;
    const est = hasEstimate ? issue.estimate! : DEFAULT_ESTIMATE;
    // si values are in half-day units; estimates are in days.
    const endSi = startSi + estimateToHalves(est);

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
        if (issue.state.type === "unstarted" || issue.state.type === "backlog" || issue.state.type === "triage" || !isActivelyInProgress(issue)) {
          earliest = Math.max(earliest, todaySi);
        }
        if (earliest <= atTime) {
          result.push({ issue, earliestSi: earliest });
        }
      }
      // Issues blocking more work go first (shortens the critical path); everything else
      // falls back to the order the team actually sees in Linear.
      result.sort((a, b) => {
        const da = downstream.get(a.issue.id) ?? 0;
        const db = downstream.get(b.issue.id) ?? 0;
        if (da !== db) return db - da;
        return compareLinearViewOrder(a.issue, b.issue);
      });
      return result;
    }

    let safetyCounter = msIssues.length * configuredNumWorkers + 100;
    while (msRemaining.size > 0 && safetyCounter-- > 0) {
      let bestUsedW = -1;
      let bestUsedFree = Infinity;
      for (let w = 0; w < configuredNumWorkers; w++) {
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
      for (let w = 0; w < configuredNumWorkers; w++) {
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

      const allUsedBusy = !Array.from({ length: configuredNumWorkers }, (_, w) => w)
        .some((w) => workerFreeAtSi[w] > 0 && workerFreeAtSi[w] <= nextReadySi);

      if (allUsedBusy) {
        let newW = -1;
        let newFree = Infinity;
        for (let w = 0; w < configuredNumWorkers; w++) {
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
            if (issue && (issue.state.type === "unstarted" || issue.state.type === "backlog" || issue.state.type === "triage" || !isActivelyInProgress(issue))) {
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

    // Safety net: whatever is still unscheduled here could not be made ready (dependency cycle,
    // or a blocker that never resolved) and would otherwise be dropped from the plan without a
    // trace. Place it on the soonest-free worker instead — a wrong date beats a missing issue.
    for (const issue of msIssues) {
      if (!msRemaining.has(issue.id)) continue;
      let earliest = Math.max(milestoneBarrier, todaySi);
      for (const bid of blockedBy.get(issue.id) ?? []) {
        earliest = Math.max(earliest, endSiMap.get(bid) ?? 0);
      }
      let w = 0;
      for (let i = 1; i < configuredNumWorkers; i++) {
        if (workerFreeAtSi[i] < workerFreeAtSi[w]) w = i;
      }
      scheduleIssueOnWorker(issue, w, Math.max(workerFreeAtSi[w], earliest));
      msRemaining.delete(issue.id);
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
    // Half-day-aware start: AM of effective day, PM if started after threshold.
    const startSi = siHalfForIsoAtOrBefore(effectiveStartedAtFor(issue));
    const endSi = endSiMap.get(issue.id) ?? startSi + HALF_PER_DAY;
    const hasEst = issue.estimate != null && issue.estimate > 0;
    const est = hasEst ? issue.estimate! : DEFAULT_ESTIMATE;
    // `duration` for the ScheduledIssue is the number of distinct calendar working days the
    // bar touches — kept as a whole-day count for back-compat with the legacy duration field.
    const daysTouched = endSi > startSi
      ? Math.floor((endSi - 1) / HALF_PER_DAY) - Math.floor(startSi / HALF_PER_DAY) + 1
      : 0;
    doneItems.push(buildScheduledIssue(issue, daysTouched, est, startSi, endSi, -1));
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
  // Sort configured-W lanes first (earliest start at top), then overflow lanes underneath.
  // This keeps the visual contract: lanes 0..(configuredWorkers-1) are the user's planned
  // capacity; anything below is the result of Phase 1 spilling over because more issues
  // were started in parallel than configured.
  const overflowLaneCutoff = numDoneLanes + configuredNumWorkers;
  const configuredScheduled = scheduled.filter((s) => s.worker < overflowLaneCutoff);
  const overflowScheduled = scheduled.filter((s) => s.worker >= overflowLaneCutoff);
  sortRowsByEarliestStart(configuredScheduled, numDoneLanes);
  const configuredLanesUsed = configuredScheduled.length > 0
    ? Math.max(...configuredScheduled.map((s) => s.worker)) - numDoneLanes + 1
    : 0;
  sortRowsByEarliestStart(overflowScheduled, numDoneLanes + configuredLanesUsed);

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
  // `endDay` carries half-day precision (.5 = PM), but totalDays is a CALENDAR DAY COUNT —
  // the gantt allocates an array of that length. Round up so the last half-day still has a
  // full column. Cycles usually mask this (their endDay is a whole day and normally sits past
  // the last bar), so it only surfaced on projects with no cycles at all.
  totalDays = Math.ceil(totalDays);

  const milestones: MilestoneInfo[] = [...projectMilestones].sort((a, b) => a.sortOrder - b.sortOrder);

  return { issues: allIssues, milestones, usedWorkers, configuredWorkers: configuredNumWorkers, totalDays, startDate, todayOffset, iterations, cycles };
}
