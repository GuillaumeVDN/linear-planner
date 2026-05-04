import { describe, it, expect } from "vitest";
import { buildMilestoneSummary } from "./StatusCircle";
import type { ScheduledIssue } from "./scheduler";

const MONDAY = new Date(2025, 3, 7); // April 7, 2025

function makeScheduledIssue(overrides: Partial<ScheduledIssue> & { id: string; identifier: string }): ScheduledIssue {
  return {
    title: overrides.identifier,
    url: `https://linear.app/${overrides.identifier}`,
    duration: overrides.estimate ?? 3,
    estimate: 3,
    startDay: 0,
    endDay: 3,
    worker: 0,
    milestone: null,
    stateName: "To do",
    stateType: "unstarted",
    stateColor: "#ccc",
    stateProgress: 0,
    priority: 0,
    priorityLabel: "No priority",
    assigneeAvatarUrl: null,
    assigneeName: null,
    daysSpent: null,
    hasEstimate: true,
    done: false,
    isLate: false,
    blockedBy: [],
    ...overrides,
  };
}

describe("buildMilestoneSummary", () => {
  describe("completed working days uses sum of daysSpent divided by workers", () => {
    it("shows totalDaysSpent/workers, not wall-clock elapsed days", () => {
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 5, daysSpent: 5,
          startDay: 0, endDay: 4, done: true, stateType: "completed",
        }),
        makeScheduledIssue({
          id: "b", identifier: "A-2", estimate: 5, daysSpent: 7,
          startDay: 0, endDay: 4, done: true, stateType: "completed",
        }),
        makeScheduledIssue({
          id: "c", identifier: "A-3", estimate: 3, daysSpent: 4,
          startDay: 6, endDay: 11, done: true, stateType: "completed",
        }),
        makeScheduledIssue({
          id: "d", identifier: "A-4", estimate: 5, daysSpent: 5,
          startDay: 6, endDay: 11, done: true, stateType: "completed",
        }),
      ];
      // 2 workers: totalDaysSpent = 5+7+4+5 = 21, doneEstimate = 5+5+3+5 = 18
      // spent/w = 21/2 = 10.5, estimate/w = 18/2 = 9
      const summary = buildMilestoneSummary(issues, MONDAY, 2);
      expect(summary.soFarCount).toBe("4 issues · 10.5 / ~9 working days");
      expect(summary.soFarStatus).toBe("1.5 days behind");
      expect(summary.soFarColor).toBe("#f97316");
    });

    it("shows ahead status when spent < estimated", () => {
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 5, daysSpent: 3,
          startDay: 0, endDay: 3, done: true, stateType: "completed",
        }),
        makeScheduledIssue({
          id: "b", identifier: "A-2", estimate: 5, daysSpent: 3,
          startDay: 0, endDay: 3, done: true, stateType: "completed",
        }),
      ];
      // 2 workers: totalDaysSpent = 6, doneEstimate = 10
      // spent/w = 3, estimate/w = 5 → 2 days ahead
      const summary = buildMilestoneSummary(issues, MONDAY, 2);
      expect(summary.soFarCount).toBe("2 issues · 3 / ~5 working days");
      expect(summary.soFarStatus).toBe("2 days ahead");
      expect(summary.soFarColor).toBe("#22c55e");
    });

    it("shows on time when spent equals estimated", () => {
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 5, daysSpent: 5,
          startDay: 0, endDay: 5, done: true, stateType: "completed",
        }),
      ];
      const summary = buildMilestoneSummary(issues, MONDAY, 1);
      expect(summary.soFarCount).toBe("1 issue · 5 / ~5 working days");
      expect(summary.soFarStatus).toBe("On time");
      expect(summary.soFarColor).toBe("#15803d");
    });

    it("matches the real-world scenario: 42 daysSpent / 2 workers = 21", () => {
      const issues = [
        makeScheduledIssue({ id: "1", identifier: "FIN-576", estimate: 5, daysSpent: 4, startDay: 0, endDay: 4, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "2", identifier: "FIN-575", estimate: 3, daysSpent: 4, startDay: 0, endDay: 4, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "3", identifier: "FIN-579", estimate: 5, daysSpent: 5, startDay: 1, endDay: 8, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "4", identifier: "FIN-583", estimate: 5, daysSpent: 5, startDay: 6, endDay: 11, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "5", identifier: "FIN-620", estimate: 5, daysSpent: 7, startDay: 2, endDay: 11, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "6", identifier: "FIN-670", estimate: 1, daysSpent: 1, startDay: 8, endDay: 9, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "7", identifier: "FIN-582", estimate: 5, daysSpent: 5, startDay: 13, endDay: 18, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "8", identifier: "FIN-687", estimate: 3, daysSpent: 5, startDay: 13, endDay: 18, done: true, stateType: "completed" }),
        makeScheduledIssue({ id: "9", identifier: "FIN-608", estimate: 1, daysSpent: 6, startDay: 17, endDay: 42, done: true, stateType: "completed" }),
      ];
      // totalDaysSpent = 4+4+5+5+7+1+5+5+6 = 42, /2 = 21
      // doneEstimate = 5+3+5+5+5+1+5+3+1 = 33, /2 = 16.5
      const summary = buildMilestoneSummary(issues, MONDAY, 2);
      expect(summary.soFarCount).toBe("9 issues · 21 / ~16.5 working days");
      expect(summary.soFarStatus).toBe("4.5 days behind");
    });
  });
});
