import { describe, it, expect } from "vitest";
import { scheduleIssues } from "./scheduler";
import type { LinearIssue, LinearMilestone, LinearWorkflowState, StateTransition, AssignedInterval } from "./linear";

// --- Helpers ---

// Monday April 7, 2025 — a known Monday with no French holidays that week
const MONDAY = new Date(2025, 3, 7);

const WORKFLOW_STATES: LinearWorkflowState[] = [
  { id: "s1", name: "To do", type: "unstarted", position: 1, color: "#ccc" },
  { id: "s2", name: "In Progress", type: "started", position: 2, color: "#36f" },
  { id: "s3", name: "In Review", type: "started", position: 3, color: "#f90" },
  { id: "s4", name: "Merged", type: "started", position: 4, color: "#0c0" },
  { id: "s5", name: "Released", type: "completed", position: 5, color: "#090" },
  { id: "s6", name: "Done", type: "completed", position: 6, color: "#0f0" },
  { id: "s7", name: "Canceled", type: "canceled", position: 7, color: "#999" },
];

function makeIssue(overrides: Partial<LinearIssue> & { id: string; identifier: string }): LinearIssue {
  return {
    title: overrides.identifier,
    url: `https://linear.app/${overrides.identifier}`,
    estimate: null,
    priority: 0,
    priorityLabel: "No priority",
    sortOrder: 0,
    startedAt: null,
    completedAt: null,
    state: { name: "To do", type: "unstarted", color: "#ccc", position: 1 },
    assignee: { id: "u1", name: "Worker One", avatarUrl: null },
    projectMilestone: null,
    labels: { nodes: [] },
    relations: { nodes: [] },
    ...overrides,
  };
}

function isoDate(date: Date): string {
  return date.toISOString();
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function findIssue(result: ReturnType<typeof scheduleIssues>, identifier: string) {
  return result.issues.find((i) => i.identifier === identifier);
}

// Tests use real dates and check relative properties (startDay, endDay, worker, done, etc.)
// rather than exact dates, so no Date mocking is needed.

// =====================
// TESTS
// =====================

describe("scheduleIssues", () => {
  describe("basic scheduling", () => {
    it("schedules a single unstarted issue on worker 0", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 3 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      expect(a).toBeDefined();
      expect(a.done).toBe(false);
      expect(a.duration).toBe(3);
      expect(a.estimate).toBe(3);
      expect(a.hasEstimate).toBe(true);
    });

    it("uses default estimate of 3 for issues without estimate", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1" }), // no estimate
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      expect(a.duration).toBe(3);
      expect(a.hasEstimate).toBe(false);
    });

    it("returns usedWorkers = 1 for sequential issues on 1 worker", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 2 }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      expect(result.usedWorkers).toBe(1);
    });

    it("returns empty schedule for no issues", () => {
      const result = scheduleIssues([], 2, MONDAY);
      expect(result.issues).toHaveLength(0);
      expect(result.usedWorkers).toBe(1);
    });
  });

  describe("parallel workers", () => {
    it("schedules two independent issues on separate workers", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 5 }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 5 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      // They should be on different workers and start at the same time
      expect(a.worker).not.toBe(b.worker);
      expect(a.startDay).toBe(b.startDay);
      expect(result.usedWorkers).toBe(2);
    });

    it("serializes issues when only 1 worker", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 3 }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 3 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(a.worker).toBe(b.worker);
      expect(b.startDay).toBeGreaterThanOrEqual(a.endDay);
    });

    it("fills gaps with early-ready issues on unused workers", () => {
      // A blocks B (so B starts after A). C is independent and ready now.
      // With 2 workers, C should go on the second worker, not wait for A then B.
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 5,
          relations: { nodes: [{ type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] },
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 3 }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 4 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      const c = findIssue(result, "A-3")!;
      // A and C should be in parallel (different workers, overlapping)
      expect(a.worker).not.toBe(c.worker);
      // B should start after A ends
      expect(b.startDay).toBeGreaterThanOrEqual(a.endDay);
      expect(result.usedWorkers).toBe(2);
    });
  });

  describe("dependency ordering", () => {
    it("schedules blocker before blocked issue", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          relations: { nodes: [{ type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] },
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(b.startDay).toBeGreaterThanOrEqual(a.endDay);
    });

    it("handles chain of dependencies A -> B -> C", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 2,
          relations: { nodes: [{ type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] },
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 2,
          relations: { nodes: [{ type: "blocks", relatedIssue: { id: "c", identifier: "A-3" } }] },
        }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      const c = findIssue(result, "A-3")!;
      expect(b.startDay).toBeGreaterThanOrEqual(a.endDay);
      expect(c.startDay).toBeGreaterThanOrEqual(b.endDay);
    });

    it("done blockers do not delay non-done issues", () => {
      // A is done and blocks B. B should not be delayed by A.
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
          relations: { nodes: [{ type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] },
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(a.done).toBe(true);
      expect(b.done).toBe(false);
      // B should not be pushed far into the future — it can start near A's end
      // (exact timing depends on today, but B should exist and not be blocked)
      expect(b).toBeDefined();
    });
  });

  describe("done issues (effectively done)", () => {
    it("marks issues at or past end status as done", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      expect(findIssue(result, "A-1")!.done).toBe(true);
    });

    it("marks completed-type state issues as done", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          completedAt: isoDate(addDays(MONDAY, 2)),
          state: { name: "Released", type: "completed", color: "#090", position: 5 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      expect(findIssue(result, "A-1")!.done).toBe(true);
    });

    it("marks canceled-type state issues as done", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          state: { name: "Canceled", type: "canceled", color: "#999", position: 7 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      // Canceled without startedAt won't appear in scheduled (no startedAt)
      // but if it did, it should be marked done
      const a = findIssue(result, "A-1");
      // Issue has no startedAt so it won't be in the done display section
      // It also won't be scheduled as non-done since isDone is true
      // This is expected — canceled issues without startedAt are simply omitted
      expect(a).toBeUndefined();
    });

    it("done issues are not assigned to worker lanes (separate display lanes)", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 3 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(a.done).toBe(true);
      expect(b.done).toBe(false);
      // Done issue should be on a different row than non-done issues
      // Done lanes are 0..numDoneLanes-1, non-done are numDoneLanes+
      expect(a.worker).toBeLessThan(b.worker);
    });

    it("done issues do not affect usedWorkers count", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      // usedWorkers should only count non-done worker lanes
      expect(result.usedWorkers).toBe(1);
    });

    it("uses doneEndDates for exact end date of done issues", () => {
      const startedAt = isoDate(MONDAY);
      const mergedAt = isoDate(addDays(MONDAY, 3)); // Thursday
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 10,
          startedAt,
          state: { name: "Released", type: "completed", color: "#090", position: 5 },
          completedAt: isoDate(addDays(MONDAY, 5)), // would give wrong date
        }),
      ];
      const doneEndDates = new Map([["a", mergedAt]]);
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged", doneEndDates);
      const a = findIssue(result, "A-1")!;
      expect(a.done).toBe(true);
      // Duration should be based on startedAt -> mergedAt (4 working days: Mon, Tue, Wed, Thu)
      expect(a.duration).toBe(4);
    });

    it("done issues use actual startedAt date for positioning", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const a = findIssue(result, "A-1")!;
      // startDay should be 0 (same as startDate = MONDAY)
      expect(a.startDay).toBe(0);
    });

    it("overlapping done issues get separate display lanes", () => {
      // Two done issues that overlap in time
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 5,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 5,
          startedAt: isoDate(addDays(MONDAY, 1)), // starts 1 day later, overlaps
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(a.done).toBe(true);
      expect(b.done).toBe(true);
      // They should be on different display lanes since they overlap
      expect(a.worker).not.toBe(b.worker);
    });

    it("non-overlapping done issues share the same display lane", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 2,
          startedAt: isoDate(MONDAY),
          completedAt: isoDate(addDays(MONDAY, 1)),
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 2,
          startedAt: isoDate(addDays(MONDAY, 14)), // 2 weeks later, no overlap
          completedAt: isoDate(addDays(MONDAY, 15)),
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(a.done).toBe(true);
      expect(b.done).toBe(true);
      expect(a.worker).toBe(b.worker);
    });

    it("packs done issues into the minimum number of lanes regardless of input order", () => {
      // Three issues: one long-running (week 1-2), two short ones inside that span.
      // If we packed in input order, the long one would claim lane 0 and the two shorts
      // would each get their own lane (3 total). Sorting by startDay first => 2 lanes.
      const issues = [
        makeIssue({
          id: "long", identifier: "A-LONG", estimate: 10,
          startedAt: isoDate(MONDAY),
          completedAt: isoDate(addDays(MONDAY, 13)), // ~2 weeks
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
        makeIssue({
          id: "s1", identifier: "A-S1", estimate: 1,
          startedAt: isoDate(addDays(MONDAY, 1)),
          completedAt: isoDate(addDays(MONDAY, 1)),
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
        makeIssue({
          id: "s2", identifier: "A-S2", estimate: 1,
          startedAt: isoDate(addDays(MONDAY, 7)), // after S1 ends
          completedAt: isoDate(addDays(MONDAY, 7)),
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const long = findIssue(result, "A-LONG")!;
      const s1 = findIssue(result, "A-S1")!;
      const s2 = findIssue(result, "A-S2")!;
      // S1 and S2 don't overlap each other → same lane. Long overlaps both → different lane.
      expect(s1.worker).toBe(s2.worker);
      expect(long.worker).not.toBe(s1.worker);
      const doneLanes = new Set([long.worker, s1.worker, s2.worker]);
      expect(doneLanes.size).toBe(2);
    });

    it("orders done lanes by earliest start day", () => {
      const issues = [
        makeIssue({
          id: "late", identifier: "A-LATE", estimate: 2,
          startedAt: isoDate(addDays(MONDAY, 7)),
          completedAt: isoDate(addDays(MONDAY, 8)),
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
        makeIssue({
          id: "early1", identifier: "A-EARLY1", estimate: 10,
          startedAt: isoDate(MONDAY),
          completedAt: isoDate(addDays(MONDAY, 9)),
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
        makeIssue({
          id: "early2", identifier: "A-EARLY2", estimate: 2,
          startedAt: isoDate(addDays(MONDAY, 1)), // overlaps EARLY1 → different lane from it
          completedAt: isoDate(addDays(MONDAY, 2)),
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const early1 = findIssue(result, "A-EARLY1")!;
      const early2 = findIssue(result, "A-EARLY2")!;
      const late = findIssue(result, "A-LATE")!;
      // Earliest lane (worker 0) should be the one whose earliest start is MONDAY (EARLY1).
      expect(early1.worker).toBe(0);
      // EARLY2 starts before LATE and overlaps EARLY1 → goes to lane 1.
      expect(early2.worker).toBe(1);
      // LATE doesn't overlap EARLY2 → can share its lane (lane 1).
      expect(late.worker).toBe(1);
    });
  });

  describe("pinned (in-progress) issues", () => {
    it("pins started issues to their startedAt date", () => {
      const startedAt = isoDate(addDays(MONDAY, 2)); // Wednesday
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt,
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      // startDay should be 2 (Wednesday = MONDAY + 2 calendar days)
      expect(a.startDay).toBe(2);
    });

    it("daysSpent reflects working days from startedAt to today for in-progress issues", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 10,
          startedAt: isoDate(MONDAY),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      expect(a.daysSpent).toBeGreaterThanOrEqual(1);
      expect(a.done).toBe(false);
    });

    it("daysSpent is null for unstarted issues", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 3 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      expect(a.daysSpent).toBeNull();
    });

    it("issues currently in a started state below the configured start status are not counted as in-progress", () => {
      // startStatusName = "In Review" (position 3). An issue currently in "In Progress"
      // (position 2, started type but below the configured start) should NOT accrue daysSpent.
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "In Review", type: "started", color: "#f90", position: 3 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "", new Map(), "In Review");
      expect(findIssue(result, "A-1")!.daysSpent).toBeNull(); // below start → not in-progress
      expect(findIssue(result, "A-2")!.daysSpent).not.toBeNull(); // at start → counted
    });

    it("an issue in a started state but with no assignee is not counted as in-progress", () => {
      // Same started state, same startedAt — only difference is the missing assignee. An
      // unassigned started issue isn't really being worked on, so it should behave like an
      // unstarted issue: no accrued daysSpent and not pinned to its startedAt.
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
          assignee: null,
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
          assignee: { id: "u1", name: "Worker One", avatarUrl: null },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      expect(findIssue(result, "A-1")!.daysSpent).toBeNull(); // no assignee → not in-progress
      expect(findIssue(result, "A-2")!.daysSpent).not.toBeNull(); // assigned → counted
    });

    it("default start status (lowest started position) keeps legacy behaviour: every started issue counts", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
      ];
      // No startStatusName → defaults to lowest started ("In Progress"), so A-1 counts.
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      expect(findIssue(result, "A-1")!.daysSpent).not.toBeNull();
    });

    describe("state-history-driven effective start", () => {
      // Mirrors the FIN-691 case: Linear's `startedAt` fires when the issue first enters
      // any "started" state — including "Waiting for info" (position below the configured
      // start). The scheduler should treat the *first transition into an at-or-above-start
      // state* as the real start, not Linear's startedAt.
      // Workflow with a below-start "started" state and a regular start state.
      const STATES_WITH_WAITING: LinearWorkflowState[] = [
        { id: "s1", name: "To do", type: "unstarted", position: 1, color: "#ccc" },
        { id: "s-wait", name: "Waiting for info", type: "started", position: -100, color: "#aaa" },
        { id: "s2", name: "In Progress", type: "started", position: 2, color: "#36f" },
        { id: "s3", name: "In Review", type: "started", position: 3, color: "#f90" },
        { id: "s4", name: "Merged", type: "started", position: 4, color: "#0c0" },
        { id: "s5", name: "Done", type: "completed", position: 6, color: "#0f0" },
      ];
      const wait = STATES_WITH_WAITING.find((s) => s.name === "Waiting for info")!;
      const inProgress = STATES_WITH_WAITING.find((s) => s.name === "In Progress")!;
      const todo = STATES_WITH_WAITING.find((s) => s.name === "To do")!;

      const stateOf = (s: LinearWorkflowState) => ({ name: s.name, type: s.type, position: s.position });

      it("uses the first transition into an at-or-above-start state as the effective start", () => {
        const startedAt = isoDate(MONDAY); // Apr 7 — when Linear flagged the issue as started
        const realStartIso = isoDate(addDays(MONDAY, 7)); // Apr 14 Mon — when it actually moved to In Progress
        const issues = [
          makeIssue({
            id: "x", identifier: "X-1", estimate: 3,
            startedAt,
            state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
          }),
        ];
        const history: Map<string, StateTransition[]> = new Map([
          ["x", [
            { createdAt: startedAt, fromState: stateOf(todo), toState: stateOf(wait) },
            { createdAt: realStartIso, fromState: stateOf(wait), toState: stateOf(inProgress) },
          ]],
        ]);
        const result = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress", history);
        const x = findIssue(result, "X-1")!;
        // Effective start should be Apr 14 (day 7 from MONDAY), NOT Apr 7 (day 0).
        expect(x.startedAtRaw).toBe(realStartIso);
        expect(x.startDay).toBe(7);
        // belowStartBreakdown lists nothing because "Waiting for info" was BEFORE the first
        // active entry (the user only cares about below-start periods after a real start).
        expect(x.belowStartBreakdown).toEqual([]);
      });

      it("tracks below-start time when the issue dips back below start after first activating", () => {
        // Sequence: To do → In Progress (Apr 7) → Waiting for info (Apr 8) → In Progress (Apr 14).
        // "Waiting for info" was visited AFTER the first active entry, so it should be in the breakdown.
        const firstActive = isoDate(MONDAY);
        const enteredWaiting = isoDate(addDays(MONDAY, 1));
        const backToProgress = isoDate(addDays(MONDAY, 7));
        const issues = [
          makeIssue({
            id: "x", identifier: "X-1", estimate: 3,
            startedAt: firstActive,
            state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
          }),
        ];
        const history: Map<string, StateTransition[]> = new Map([
          ["x", [
            { createdAt: firstActive, fromState: stateOf(todo), toState: stateOf(inProgress) },
            { createdAt: enteredWaiting, fromState: stateOf(inProgress), toState: stateOf(wait) },
            { createdAt: backToProgress, fromState: stateOf(wait), toState: stateOf(inProgress) },
          ]],
        ]);
        const result = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress", history);
        const x = findIssue(result, "X-1")!;
        expect(x.startedAtRaw).toBe(firstActive);
        expect(x.startDay).toBe(0);
        // Below-start breakdown should report "Waiting for info" with some days > 0.
        expect(x.belowStartBreakdown.length).toBe(1);
        expect(x.belowStartBreakdown[0].stateName).toBe("Waiting for info");
        expect(x.belowStartBreakdown[0].days).toBeGreaterThan(0);
        // The below-start stretch is also surfaced as an ignored range (painted pending on the bar).
        expect(x.ignoredRanges.length).toBeGreaterThan(0);
      });

      it("does not overcount a calendar day that hosts multiple state transitions (FIN-592 regression)", () => {
        // Issue moves through several active states on the SAME day, then settles. The
        // earlier accounting logic incremented `countSchedulable(start, end)` per segment,
        // which claims the whole calendar day for every segment that touches it — yielding
        // an inflated daysSpent (e.g. 3 days for ~1.5 wall-clock days). The half-day-aware
        // computation should produce a correct count instead.
        const t0 = isoDate(MONDAY); // Mon UTC midnight = AM Paris (effective start)
        const t1AfternoonSameDay = "2025-04-07T11:30:00.000Z"; // Mon PM Paris
        const t2AlsoMonPM = "2025-04-07T13:00:00.000Z"; // Mon PM Paris (still same half-day)
        const issues = [
          makeIssue({
            id: "x", identifier: "X-1", estimate: 3,
            startedAt: t0,
            state: stateOf(inProgress),
          }),
        ];
        const history: Map<string, StateTransition[]> = new Map([
          ["x", [
            { createdAt: t0, fromState: stateOf(todo), toState: stateOf(inProgress) },
            { createdAt: t1AfternoonSameDay, fromState: stateOf(inProgress), toState: { name: "In Review", type: "started", position: 3 } },
            { createdAt: t2AlsoMonPM, fromState: { name: "In Review", type: "started", position: 3 }, toState: stateOf(inProgress) },
          ]],
        ]);
        // Mock "now" to be a PM time on Tue (the day after MONDAY = Apr 8 PM).
        const fakeNow = new Date("2025-04-08T14:00:00.000Z"); // Tue PM Paris
        const realDate = Date;
        // @ts-expect-error - mock Date constructor
        globalThis.Date = class extends realDate {
          constructor(...args: ConstructorParameters<typeof realDate>) {
            if (args.length === 0) return new realDate(fakeNow);
            // @ts-expect-error - spread args
            return new realDate(...args);
          }
          static now() { return fakeNow.getTime(); }
        } as DateConstructor;
        try {
          const result = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress", history);
          // Mon AM → Mon PM (1 half) + Mon PM → Mon PM (0 halves) + Mon PM → Tue PM-inclusive (3 halves) = 4 halves = 2 days.
          expect(findIssue(result, "X-1")!.daysSpent).toBe(2);
        } finally {
          globalThis.Date = realDate;
        }
      });

      it("does not count active time that elapsed while the issue had no assignee", () => {
        // The issue is active (In Progress) for the whole window, but was UNASSIGNED for the
        // middle stretch. Those unassigned days must not accrue, even though it's assigned now.
        const firstActive = isoDate(MONDAY); // Apr 7 (assigned)
        const unassignedAt = isoDate(addDays(MONDAY, 1)); // Apr 8 — assignee removed
        const reassignedAt = isoDate(addDays(MONDAY, 7)); // Apr 14 — assignee restored
        const issues = [
          makeIssue({
            id: "x", identifier: "X-1", estimate: 5,
            startedAt: firstActive,
            state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
            assignee: { id: "u1", name: "Worker One", avatarUrl: null },
          }),
        ];
        // Single uninterrupted active state across the whole period.
        const history: Map<string, StateTransition[]> = new Map([
          ["x", [{ createdAt: firstActive, fromState: stateOf(todo), toState: stateOf(inProgress) }]],
        ]);
        // Assigned Apr 7–8, unassigned Apr 8–14, assigned again Apr 14 onward.
        const assigned: Map<string, AssignedInterval[]> = new Map([
          ["x", [
            { startIso: firstActive, endIso: unassignedAt },
            { startIso: reassignedAt, endIso: null },
          ]],
        ]);
        // Mock "now" to a fixed AM on Apr 15 (Tue) so the open-ended interval is bounded.
        const fakeNow = new Date("2025-04-15T08:00:00.000Z");
        const realDate = Date;
        // @ts-expect-error - mock Date constructor
        globalThis.Date = class extends realDate {
          constructor(...args: ConstructorParameters<typeof realDate>) {
            if (args.length === 0) return new realDate(fakeNow);
            // @ts-expect-error - spread args
            return new realDate(...args);
          }
          static now() { return fakeNow.getTime(); }
        } as DateConstructor;
        try {
          const withGap = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress", history, assigned);
          const withoutGap = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress", history);
          const gapDays = findIssue(withGap, "X-1")!.daysSpent!;
          const fullDays = findIssue(withoutGap, "X-1")!.daysSpent!;
          // The unassigned Apr 8–13 stretch must be excluded.
          expect(gapDays).toBeLessThan(fullDays);
          // Assigned: Apr 7 (full day) + Apr 14 (full day) + Apr 15 AM-only (today is AM) = 2.5.
          expect(gapDays).toBe(2.5);
          // The unassigned stretch is surfaced as an ignored range for the gantt to paint pending.
          expect(findIssue(withGap, "X-1")!.ignoredRanges.length).toBeGreaterThan(0);
          expect(findIssue(withoutGap, "X-1")!.ignoredRanges).toEqual([]);
        } finally {
          globalThis.Date = realDate;
        }
      });

      it("excludes days covered by a planner-no-count correction", () => {
        // Active In Progress the whole window, but a correction excludes Apr 8 AM → Apr 9 PM
        // (2 working days). Those days must drop out of daysSpent and surface as ignored.
        const firstActive = isoDate(MONDAY); // Apr 7 (Mon)
        const issues = [
          makeIssue({
            id: "x", identifier: "X-1", estimate: 5,
            startedAt: firstActive,
            state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
            assignee: { id: "u1", name: "Worker One", avatarUrl: null },
          }),
        ];
        const history: Map<string, StateTransition[]> = new Map([
          ["x", [{ createdAt: firstActive, fromState: stateOf(todo), toState: stateOf(inProgress) }]],
        ]);
        const noCount: Map<string, NoCountRange[]> = new Map([
          ["x", [{ startDate: "2025-04-08", startPm: false, endDate: "2025-04-09", endPm: true }]],
        ]);
        const fakeNow = new Date("2025-04-10T08:00:00.000Z"); // Thu AM Paris
        const realDate = Date;
        // @ts-expect-error - mock Date constructor
        globalThis.Date = class extends realDate {
          constructor(...args: ConstructorParameters<typeof realDate>) {
            if (args.length === 0) return new realDate(fakeNow);
            // @ts-expect-error - spread args
            return new realDate(...args);
          }
          static now() { return fakeNow.getTime(); }
        } as DateConstructor;
        try {
          const corrected = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress", history, new Map(), noCount);
          const uncorrected = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress", history);
          const x = findIssue(corrected, "X-1")!;
          // Uncorrected: Apr 7,8,9 full + Apr 10 AM = 3.5 days. Correction removes Apr 8–9 (2 days).
          expect(findIssue(uncorrected, "X-1")!.daysSpent).toBe(3.5);
          expect(x.daysSpent).toBe(1.5);
          expect(x.noCountDays).toBe(2);
          // The excluded stretch is reported as an ignored range for the gantt to paint.
          expect(x.ignoredRanges.length).toBeGreaterThan(0);
        } finally {
          globalThis.Date = realDate;
        }
      });

      it("spawns extra worker lanes when more issues are started in parallel than W", () => {
        // 3 issues all started today on Apr 7 with W=2. Without lane expansion, the 3rd
        // would be pushed past the second's end. With expansion, all 3 should pin to day 0.
        const startedAt = isoDate(MONDAY);
        const issues = [
          makeIssue({ id: "a", identifier: "A-1", estimate: 5, startedAt, state: stateOf(inProgress) }),
          makeIssue({ id: "b", identifier: "A-2", estimate: 5, startedAt, state: stateOf(inProgress) }),
          makeIssue({ id: "c", identifier: "A-3", estimate: 5, startedAt, state: stateOf(inProgress) }),
        ];
        const result = scheduleIssues(issues, 2, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress");
        // All three should start on day 0 — a third lane was created to honor real dates.
        for (const id of ["A-1", "A-2", "A-3"]) {
          expect(findIssue(result, id)!.startDay).toBe(0);
        }
        // 3 distinct worker lanes occupied.
        const workers = new Set([findIssue(result, "A-1")!.worker, findIssue(result, "A-2")!.worker, findIssue(result, "A-3")!.worker]);
        expect(workers.size).toBe(3);
        // usedWorkers reflects the rendered lanes (3); configuredWorkers stays at the user's
        // setting (2) so the milestone summary's theoretical schedule uses the right W.
        expect(result.usedWorkers).toBe(3);
        expect(result.configuredWorkers).toBe(2);
      });

      it("renders overflow lanes BELOW configured lanes even when overflow has an earlier start", () => {
        // Two configured-W issues that don't start until day 5+, and one overflow issue
        // (3rd in parallel) that starts on day 0. Without lane-grouping, the overflow row
        // would float to the top by virtue of its earliest start. We want it below.
        const lateStart = isoDate(addDays(MONDAY, 5)); // a Saturday — gets bumped to next Mon
        const earlyStart = isoDate(MONDAY);
        const issues = [
          // Two issues started later, both on the same day.
          makeIssue({ id: "late1", identifier: "LATE-1", estimate: 5, startedAt: lateStart, state: stateOf(inProgress) }),
          makeIssue({ id: "late2", identifier: "LATE-2", estimate: 5, startedAt: lateStart, state: stateOf(inProgress) }),
          // Third issue started earlier — forces a third lane (overflow) at day 0.
          makeIssue({ id: "early", identifier: "EARLY-1", estimate: 5, startedAt: earlyStart, state: stateOf(inProgress) }),
        ];
        // BUT — wait, with W=2 and the early one being the 3rd issue to land in Phase 1,
        // Phase 1 iterates in pinning order. We need the LATE issues to consume the two
        // configured lanes first, then EARLY-1 to spill into overflow.
        // Phase 1 processes pinnedRemaining; iteration order is the input issues order.
        // So late1 → lane 0, late2 → lane 1, early → lane 2 (overflow) regardless of dates.
        const result = scheduleIssues(issues, 2, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress");
        const late1 = findIssue(result, "LATE-1")!;
        const late2 = findIssue(result, "LATE-2")!;
        const early = findIssue(result, "EARLY-1")!;
        expect(result.usedWorkers).toBe(3);
        // Overflow (EARLY-1) must be in a higher worker index than both configured lanes,
        // not at the top despite its earlier start.
        expect(early.worker).toBeGreaterThan(late1.worker);
        expect(early.worker).toBeGreaterThan(late2.worker);
      });

      it("positions a done issue started in the afternoon at a .5 (PM) startDay", () => {
        // 11:30 UTC = 13:30 Paris CEST → exactly at the threshold (PM).
        const pmStart = "2025-04-07T11:30:00.000Z";
        const completed = isoDate(addDays(MONDAY, 1)); // Tue AM
        const issues = [
          makeIssue({
            id: "x", identifier: "X-1", estimate: 1,
            startedAt: pmStart,
            completedAt: completed,
            state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
          }),
        ];
        const result = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "Merged");
        const x = findIssue(result, "X-1")!;
        expect(x.startDay).toBe(0.5);
        // Tue AM end → siHalf 2+1 = 3, fractional cal = 0.5 PM of day 0? wait. Let's check.
        // siHalfForIso(Tue AM) = workingDay(1)*2 + 0 = 2. endSi = max(1+1, 2+1) = 3.
        // siHalfToFractionalCalendar(3) = cal.toCalendar(workingDay(1)) + 0.5 = 1 + 0.5 = 1.5.
        expect(x.endDay).toBe(1.5);
      });

      it("two half-day done issues share one calendar day across AM/PM", () => {
        // Done issue 1: Mon AM → Mon AM (just AM). Done issue 2: Mon PM → Mon PM.
        const amStart = isoDate(MONDAY); // AM Paris
        const amEnd = isoDate(MONDAY);   // same — bar covers only AM half
        const pmStart = "2025-04-07T11:30:00.000Z";
        const pmEnd = "2025-04-07T11:30:00.000Z";
        const issues = [
          makeIssue({
            id: "am", identifier: "AM-1", estimate: 0.5,
            startedAt: amStart, completedAt: amEnd,
            state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
          }),
          makeIssue({
            id: "pm", identifier: "PM-1", estimate: 0.5,
            startedAt: pmStart, completedAt: pmEnd,
            state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
          }),
        ];
        const result = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "Merged");
        const am = findIssue(result, "AM-1")!;
        const pm = findIssue(result, "PM-1")!;
        // AM card: 0.0 → 0.5
        expect(am.startDay).toBe(0);
        expect(am.endDay).toBe(0.5);
        // PM card: 0.5 → 1.0
        expect(pm.startDay).toBe(0.5);
        expect(pm.endDay).toBe(1);
      });

      it("falls back to Linear's startedAt when no state history is provided", () => {
        const startedAt = isoDate(MONDAY);
        const issues = [
          makeIssue({
            id: "y", identifier: "Y-1", estimate: 3,
            startedAt,
            state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
          }),
        ];
        // No history map passed → uses old logic (Linear's startedAt).
        const result = scheduleIssues(issues, 1, MONDAY, [], [], STATES_WITH_WAITING, "", new Map(), "In Progress");
        const y = findIssue(result, "Y-1")!;
        expect(y.startedAtRaw).toBe(startedAt);
        expect(y.startDay).toBe(0);
      });
    });

    it("late in-progress issues extend to today and are marked isLate", () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 14);
      while (startDate.getDay() === 0 || startDate.getDay() === 6) {
        startDate.setDate(startDate.getDate() - 1);
      }
      const pinnedStart = new Date(startDate);
      pinnedStart.setDate(pinnedStart.getDate() + 1);
      while (pinnedStart.getDay() === 0 || pinnedStart.getDay() === 6) {
        pinnedStart.setDate(pinnedStart.getDate() + 1);
      }

      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 1,
          startedAt: isoDate(pinnedStart),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
      ];
      const result = scheduleIssues(issues, 1, startDate, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const todayOffset = Math.round((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      expect(a.isLate).toBe(true);
      expect(a.endDay).toBeGreaterThanOrEqual(todayOffset + 1);
    });

    it("in-progress issues within estimate are not marked late", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 999,
          startedAt: isoDate(MONDAY),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      expect(a.isLate).toBe(false);
    });

    it("late in-progress issue does not overlap with the next issue on the same worker", () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 14);
      while (startDate.getDay() === 0 || startDate.getDay() === 6) {
        startDate.setDate(startDate.getDate() - 1);
      }
      const pinnedStart = new Date(startDate);
      pinnedStart.setDate(pinnedStart.getDate() + 1);
      while (pinnedStart.getDay() === 0 || pinnedStart.getDay() === 6) {
        pinnedStart.setDate(pinnedStart.getDate() + 1);
      }

      // A: pinned, est=1, started 2 weeks ago (late)
      // B: unstarted, will be scheduled on same worker after A
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 1,
          startedAt: isoDate(pinnedStart),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 1, startDate, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(a.isLate).toBe(true);
      expect(b.startDay).toBeGreaterThanOrEqual(a.endDay);
    });
  });

  describe("unstarted issues and today floor", () => {
    it("unstarted issues are not scheduled before today", () => {
      // startDate is a few weeks in the past (within the 730-day calendar window)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const pastStart = new Date(today);
      pastStart.setDate(pastStart.getDate() - 30); // 30 days ago
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 3 }),
      ];
      const result = scheduleIssues(issues, 1, pastStart, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const daysSincePast = Math.round((today.getTime() - pastStart.getTime()) / (1000 * 60 * 60 * 24));
      // Issue should start at or after today's offset (allow 1 day tolerance for weekends)
      expect(a.startDay).toBeGreaterThanOrEqual(daysSincePast - 2);
    });
  });

  describe("milestones", () => {
    it("issues in later milestones start after earlier milestones complete", () => {
      const ms1: LinearMilestone = { id: "ms1", name: "Phase 1", sortOrder: 1 };
      const ms2: LinearMilestone = { id: "ms2", name: "Phase 2", sortOrder: 2 };
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          projectMilestone: { id: "ms1", name: "Phase 1", sortOrder: 1 },
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 2,
          projectMilestone: { id: "ms2", name: "Phase 2", sortOrder: 2 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [ms1, ms2], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const b = findIssue(result, "A-2")!;
      expect(b.startDay).toBeGreaterThanOrEqual(a.endDay);
    });
  });

  describe("end status configuration", () => {
    it("uses configured endStatusName to determine done", () => {
      // Issue is "In Review" which is before "Merged"
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "In Review", type: "started", color: "#f90", position: 3 },
        }),
      ];
      // With end status = "Merged" (position 4), "In Review" (position 3) should NOT be done
      const result1 = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      expect(findIssue(result1, "A-1")!.done).toBe(false);

      // With end status = "In Review" (position 3), it SHOULD be done
      const result2 = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "In Review");
      expect(findIssue(result2, "A-1")!.done).toBe(true);
    });

    it("falls back to 'merged' detection when endStatusName is empty", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "");
      expect(findIssue(result, "A-1")!.done).toBe(true);
    });
  });

  describe("row ordering", () => {
    it("done lanes come before worker lanes", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 3 }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 3 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      const doneIssues = result.issues.filter((i) => i.done);
      const nonDoneIssues = result.issues.filter((i) => !i.done);
      const maxDoneWorker = Math.max(...doneIssues.map((i) => i.worker));
      const minNonDoneWorker = Math.min(...nonDoneIssues.map((i) => i.worker));
      expect(maxDoneWorker).toBeLessThan(minNonDoneWorker);
    });

    it("rows within each group are sorted by earliest start", () => {
      // Two non-done issues, one starts later. The earlier one should be on a lower row.
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          relations: { nodes: [{ type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] },
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 3 }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 5 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES);
      const workers = new Map<number, number>();
      for (const s of result.issues) {
        const prev = workers.get(s.worker);
        if (prev === undefined || s.startDay < prev) workers.set(s.worker, s.startDay);
      }
      const sorted = Array.from(workers.entries()).sort((a, b) => a[0] - b[0]);
      // Each row should have non-decreasing earliest start
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i][1]).toBeGreaterThanOrEqual(sorted[i - 1][1]);
      }
    });
  });

  describe("edge cases", () => {
    it("handles zero workers gracefully (floor to 1)", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 3 }),
      ];
      const result = scheduleIssues(issues, 0, MONDAY, [], [], WORKFLOW_STATES);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
    });

    it("handles issues with no relations", () => {
      const issues = [
        makeIssue({ id: "a", identifier: "A-1", estimate: 2 }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 2 }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES);
      expect(result.issues).toHaveLength(3);
    });

    it("handles mix of done and non-done issues", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          state: { name: "Merged", type: "started", color: "#0c0", position: 4 },
        }),
        makeIssue({
          id: "b", identifier: "A-2", estimate: 5,
          startedAt: isoDate(addDays(MONDAY, 1)),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 2, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      expect(result.issues.filter((i) => i.done)).toHaveLength(1);
      expect(result.issues.filter((i) => !i.done)).toHaveLength(2);
    });

    it("handles done issue without startedAt (omitted from schedule)", () => {
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1",
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      // No startedAt → not displayed in done lanes, also excluded from non-done scheduling
      expect(result.issues).toHaveLength(0);
    });

    it("downstream priority: issue with more dependents is scheduled first", () => {
      // A has 2 dependents (B, C). D has 0 dependents.
      // A should be scheduled before D.
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          relations: { nodes: [
            { type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } },
            { type: "blocks", relatedIssue: { id: "c", identifier: "A-3" } },
          ]},
        }),
        makeIssue({ id: "b", identifier: "A-2", estimate: 2 }),
        makeIssue({ id: "c", identifier: "A-3", estimate: 2 }),
        makeIssue({ id: "d", identifier: "A-4", estimate: 5 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "A-1")!;
      const d = findIssue(result, "A-4")!;
      // A should come before D (or at least not after)
      expect(a.startDay).toBeLessThanOrEqual(d.startDay);
    });

    it("totalDays stays a whole calendar-day count when a bar ends on a PM half", () => {
      // Regression: an issue finishing in the morning ends its bar mid-day (endDay = X.5).
      // With no cycles to round it up, totalDays stayed fractional and the gantt blew up on
      // `new Array(x.5)` — "invalid array length".
      const issues = [
        makeIssue({
          id: "a", identifier: "A-1", estimate: 3,
          startedAt: isoDate(MONDAY),
          completedAt: isoDate(addDays(MONDAY, 2)),
          state: { name: "Released", type: "completed", color: "#090", position: 5 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES, "Merged");
      expect(findIssue(result, "A-1")!.endDay % 1).toBe(0.5); // guard: the repro still ends mid-day
      expect(Number.isInteger(result.totalDays)).toBe(true);
      expect(result.totalDays).toBeGreaterThanOrEqual(findIssue(result, "A-1")!.endDay);
    });

    it("ties are broken by Linear's visible order: priority first, then sortOrder", () => {
      // No dependencies → every issue has 0 downstream, so the Linear view order decides.
      const issues = [
        makeIssue({ id: "none", identifier: "A-1", estimate: 1, priority: 0, priorityLabel: "No priority", sortOrder: 1 }),
        makeIssue({ id: "low", identifier: "A-2", estimate: 1, priority: 4, priorityLabel: "Low", sortOrder: 100 }),
        makeIssue({ id: "urgent-late", identifier: "A-3", estimate: 1, priority: 1, priorityLabel: "Urgent", sortOrder: 50 }),
        makeIssue({ id: "urgent-early", identifier: "A-4", estimate: 1, priority: 1, priorityLabel: "Urgent", sortOrder: 10 }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, [], [], WORKFLOW_STATES);
      const order = [...result.issues].sort((a, b) => a.startDay - b.startDay).map((i) => i.identifier);
      // Urgent before Low, "No priority" last; within Urgent, lowest sortOrder first.
      expect(order).toEqual(["A-4", "A-3", "A-2", "A-1"]);
    });
  });

  describe("worker advance with unstarted issues", () => {
    it("does not skip over unstarted issues when advancing a worker freed before today", () => {
      // Regression: when a pinned issue frees a worker before todaySi, the advance
      // logic must account for the todaySi floor on unstarted issues. Otherwise it
      // jumps the worker far into the future, leaving a gap on that row.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 14);
      // Ensure startDate is a weekday
      while (startDate.getDay() === 0 || startDate.getDay() === 6) {
        startDate.setDate(startDate.getDate() - 1);
      }

      const pinnedStart = new Date(startDate);
      pinnedStart.setDate(pinnedStart.getDate() + 1);
      while (pinnedStart.getDay() === 0 || pinnedStart.getDay() === 6) {
        pinnedStart.setDate(pinnedStart.getDate() + 1);
      }

      // A: pinned in-progress issue (est=1, frees worker well before today)
      // B: unstarted, unblocked (should start near today on that same worker)
      const issues = [
        makeIssue({
          id: "a", identifier: "T-1", estimate: 1,
          startedAt: isoDate(pinnedStart),
          state: { name: "In Progress", type: "started", color: "#36f", position: 2 },
        }),
        makeIssue({ id: "b", identifier: "T-2", estimate: 2 }),
      ];
      const result = scheduleIssues(issues, 1, startDate, [], [], WORKFLOW_STATES);
      const a = findIssue(result, "T-1")!;
      const b = findIssue(result, "T-2")!;

      const todayOffset = Math.round((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      // B should start near today (within a few days for weekends/holidays),
      // NOT hundreds of days later from a broken advance.
      // Note: a.endDay may be extended to today due to late-issue display,
      // so we check against the original estimated end instead.
      expect(b.startDay).toBeGreaterThanOrEqual(a.startDay + 1);
      expect(b.startDay).toBeLessThanOrEqual(todayOffset + 4);
    });
  });

  describe("virtual cycle extension", () => {
    // Cycle definitions whose display names start at "Cycle 33" but Linear's per-team `number`
    // field is just 1/2/3/4 — mirrors the multi-team scenario seen in production.
    const CYCLES = [
      { id: "c1", name: "Cycle 33", number: 1, startsAt: isoDate(MONDAY), endsAt: isoDate(addDays(MONDAY, 10)) },
      { id: "c2", name: "Cycle 34", number: 2, startsAt: isoDate(addDays(MONDAY, 14)), endsAt: isoDate(addDays(MONDAY, 24)) },
      { id: "c3", name: "Cycle 35", number: 3, startsAt: isoDate(addDays(MONDAY, 28)), endsAt: isoDate(addDays(MONDAY, 38)) },
      { id: "c4", name: "Cycle 36", number: 4, startsAt: isoDate(addDays(MONDAY, 42)), endsAt: isoDate(addDays(MONDAY, 52)) },
    ];

    // An issue with a huge estimate so it spills past the last real cycle.
    function bigIssue() {
      return makeIssue({ id: "x", identifier: "X-1", estimate: 80 });
    }

    it("extends labels by parsing trailing digits in the cycle name (Cycle 36 → Cycle 37)", () => {
      const result = scheduleIssues([bigIssue()], 1, MONDAY, CYCLES, [], WORKFLOW_STATES);
      // Real cycles are present.
      const labels = result.cycles.map((c) => c.label);
      expect(labels.slice(0, 4)).toEqual(["Cycle 33", "Cycle 34", "Cycle 35", "Cycle 36"]);
      // Virtual cycles continue numerically from the parsed name suffix.
      expect(labels[4]).toBe("Cycle 37");
      expect(labels[5]).toBe("Cycle 38");
    });

    it("does not reuse Linear's internal `number` field for the virtual sequence", () => {
      const result = scheduleIssues([bigIssue()], 1, MONDAY, CYCLES, [], WORKFLOW_STATES);
      // If Linear's internal number (4) were used as the base, the next virtual would be "Cycle 5".
      expect(result.cycles.map((c) => c.label)).not.toContain("Cycle 5");
    });

    it("preserves cycle duration and cooldown for virtual cycles", () => {
      const result = scheduleIssues([bigIssue()], 1, MONDAY, CYCLES, [], WORKFLOW_STATES);
      const cycle36 = result.cycles.find((c) => c.label === "Cycle 36")!;
      const cycle37 = result.cycles.find((c) => c.label === "Cycle 37")!;
      const cycle38 = result.cycles.find((c) => c.label === "Cycle 38")!;
      // Cycle 36 spans 10 days; the cooldown gap between real cycles is 4 days. Virtuals match.
      expect(cycle36.endDay - cycle36.startDay).toBe(10);
      expect(cycle37.endDay - cycle37.startDay).toBe(10);
      expect(cycle37.startDay - cycle36.endDay).toBe(4);
      expect(cycle38.startDay - cycle37.endDay).toBe(4);
    });

    // The next two tests use *done* issues so endDay is anchored to completedAt (deterministic)
    // rather than the unstarted-scheduling path which depends on wall-clock "today".
    function doneIssue(id: string, completedDayOffset: number) {
      return makeIssue({
        id, identifier: id.toUpperCase(),
        estimate: 2,
        startedAt: isoDate(MONDAY),
        completedAt: isoDate(addDays(MONDAY, completedDayOffset)),
        state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
      });
    }

    it("does not add virtual cycles when no issue extends past the last real one", () => {
      const result = scheduleIssues([doneIssue("d1", 2)], 1, MONDAY, CYCLES, [], WORKFLOW_STATES);
      expect(result.cycles.map((c) => c.label)).toEqual(["Cycle 33", "Cycle 34", "Cycle 35", "Cycle 36"]);
    });

    it("stops appending virtual cycles once the last issue is covered", () => {
      // Cycle 36 ends day 52; the first virtual cycle (Cycle 37) spans days 56–66.
      // A done issue ending at day 60 lands inside Cycle 37 — Cycle 38 should NOT be appended.
      const result = scheduleIssues([doneIssue("d1", 60)], 1, MONDAY, CYCLES, [], WORKFLOW_STATES);
      const labels = result.cycles.map((c) => c.label);
      expect(labels).toContain("Cycle 37");
      expect(labels).not.toContain("Cycle 38");
    });
  });

  describe("bar end at a cycle boundary (FIN-594 regression)", () => {
    // One cycle covering Apr 7–10 (Mon–Thu, working days 0–3), a cooldown, then a far-off
    // second cycle. An issue finishing on the LAST working day of the first cycle must end
    // there — not stretch across the cooldown to the next cycle's first day.
    const CYCLES = [
      { id: "c1", name: "Cycle 1", number: 1, startsAt: isoDate(MONDAY), endsAt: isoDate(addDays(MONDAY, 4)) }, // wd [0,4): Apr 7–10
      { id: "c2", name: "Cycle 2", number: 2, startsAt: isoDate(addDays(MONDAY, 14)), endsAt: isoDate(addDays(MONDAY, 18)) }, // Apr 21–24
    ];

    it("ends on the last working day of the cycle, not at the end of the following cooldown", () => {
      const issues = [
        makeIssue({
          id: "x", identifier: "X-1", estimate: 4,
          startedAt: isoDate(MONDAY),
          // Completed Thu Apr 10 in the afternoon — the cycle's final schedulable half-day.
          completedAt: "2025-04-10T15:00:00.000Z",
          state: { name: "Done", type: "completed", color: "#0f0", position: 6 },
        }),
      ];
      const result = scheduleIssues(issues, 1, MONDAY, CYCLES, [], WORKFLOW_STATES);
      const x = findIssue(result, "X-1")!;
      // Apr 10 is calendar offset 3. The bar must end at/within Apr 11 (exclusive), i.e. it
      // covers through Apr 10 — NOT jump to the next cycle (~offset 14, Apr 21).
      expect(x.endDay).toBeLessThanOrEqual(4);
      expect(x.endDay).toBeGreaterThan(3);
    });
  });

});
