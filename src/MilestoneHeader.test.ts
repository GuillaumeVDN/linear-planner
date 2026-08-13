import { describe, it, expect } from "vitest";
import { buildMilestoneSummary } from "./MilestoneHeader";
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
  describe("ongoing is expressed in the same unit as the other lines", () => {
    it("divides ongoing spent and estimate by the worker count", () => {
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 4, daysSpent: 3,
          startDay: 0, endDay: 4, stateType: "started",
        }),
        makeScheduledIssue({
          id: "b", identifier: "A-2", estimate: 6, daysSpent: 5,
          startDay: 0, endDay: 6, stateType: "started",
        }),
      ];
      // 8 days spent / 10 estimated across 2 workers → 4 / ~5, not 8 / ~10.
      const summary = buildMilestoneSummary(issues, MONDAY, 2);
      expect(summary.ongoingCount).toBe("2 issues · 4 / ~5 working days");
      expect(summary.ongoingStatus).toBe("On time");
    });

    it("reports the behind-schedule gap in the same divided unit", () => {
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 2, daysSpent: 5,
          startDay: 0, endDay: 5, stateType: "started",
        }),
        makeScheduledIssue({
          id: "b", identifier: "A-2", estimate: 2, daysSpent: 5,
          startDay: 0, endDay: 5, stateType: "started",
        }),
      ];
      // 10 spent vs 4 estimated over 2 workers → 5 / ~2, so 3 days behind (not 6).
      const summary = buildMilestoneSummary(issues, MONDAY, 2);
      expect(summary.ongoingCount).toBe("2 issues · 5 / ~2 working days");
      expect(summary.ongoingStatus).toBe("3 days behind");
      expect(summary.ongoingColor).toBe("#f97316");
    });
  });

  describe("completed status compares wall-clock elapsed working days vs estimate/workers", () => {
    it("4 parallel issues, 2 workers — actual wall-clock slightly ahead of theoretical schedule", () => {
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
      // Theoretical: 4 jobs (5, 5, 3, 5) with W=2 → 10 working days (one worker takes 5+5=10).
      // Wall-clock: minStart=0, maxEnd=11 → 9 working days. Ahead by 1.
      const summary = buildMilestoneSummary(issues, MONDAY, 2);
      expect(summary.soFarCount).toBe("4 issues · 9 / ~10 working days");
      expect(summary.soFarStatus).toBe("1 days ahead");
      expect(summary.soFarColor).toBe("#22c55e");
    });

    it("two parallel issues completed in 3 working days vs estimate 10 / 2 workers = 5 → 2 days ahead", () => {
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
      const summary = buildMilestoneSummary(issues, MONDAY, 2);
      expect(summary.soFarCount).toBe("2 issues · 3 / ~5 working days");
      expect(summary.soFarStatus).toBe("2 days ahead");
      expect(summary.soFarColor).toBe("#22c55e");
    });

    it("single issue, 1 worker, 5 working days spent = 5 estimated → on time", () => {
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

    // The user's exact concern: 3 issues, each took slightly more than estimated, but they ran
    // in parallel so wall-clock elapsed is well under the total estimate. With 1 worker
    // configured the wall-clock comparison correctly reports "ahead".
    it("3 parallel issues all slightly over per-issue, but wall-clock < total estimate → ahead", () => {
      const issues = [
        makeScheduledIssue({
          id: "fin575", identifier: "FIN-575", estimate: 3, daysSpent: 3.5,
          startDay: 0, endDay: 3, done: true, stateType: "completed", // apr 7 → apr 10
        }),
        makeScheduledIssue({
          id: "fin579", identifier: "FIN-579", estimate: 5, daysSpent: 5,
          startDay: 1, endDay: 6, done: true, stateType: "completed", // apr 8 → apr 14
        }),
        makeScheduledIssue({
          id: "fin620", identifier: "FIN-620", estimate: 5, daysSpent: 6.5,
          startDay: 2, endDay: 10, done: true, stateType: "completed", // apr 9 → apr 17
        }),
      ];
      // Wall-clock: minStart=0, maxEnd=10 → days 0..9 = apr 7..apr 16
      //   weekends apr 12,13 excluded → 8 working days
      // Estimate total = 13, /1 worker = 13 expected → 13 - 8 = 5 days ahead.
      const summary = buildMilestoneSummary(issues, MONDAY, 1);
      expect(summary.soFarCount).toBe("3 issues · 8 / ~13 working days");
      expect(summary.soFarStatus).toBe("5 days ahead");
      expect(summary.soFarColor).toBe("#22c55e");
    });

    it("sequential issues with 1 worker: wall-clock ~ total estimate", () => {
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 5, daysSpent: 5,
          startDay: 0, endDay: 5, done: true, stateType: "completed", // apr 7 → apr 11 (5 wd)
        }),
        makeScheduledIssue({
          id: "b", identifier: "A-2", estimate: 5, daysSpent: 5,
          startDay: 7, endDay: 12, done: true, stateType: "completed", // apr 14 → apr 18 (5 wd)
        }),
      ];
      // Wall-clock minStart=0, maxEnd=12 → working days = apr 7-11 (5) + apr 14-17 (4) = 9?
      // Actually [0,12) = days 0..11 = apr 7..apr 18.
      //   weekends apr 12,13 excluded → 10 working days
      // Estimate total = 10, /1 worker = 10 expected → 10 - 10 = 0 → on time
      const summary = buildMilestoneSummary(issues, MONDAY, 1);
      expect(summary.soFarCount).toBe("2 issues · 10 / ~10 working days");
      expect(summary.soFarStatus).toBe("On time");
    });
  });

  describe("cooldown gap exclusion (cycles)", () => {
    // Use a Monday with no nearby French holidays to keep math clean.
    const JUNE16 = new Date(2025, 5, 16); // Jun 16 2025 (Mon)

    // Cycle A: Jun 16 (Mon) → Jun 20 (Fri) inclusive = days 0..4, endDay 5 (exclusive)
    // Cooldown: Jun 21 (Sat) → Jun 29 (Sun) → days 5..13 — contains weekdays Jun 23-27 that
    //   should NOT count as schedulable.
    // Cycle B: Jun 30 (Mon) → Jul 4 (Fri) = days 14..18, endDay 19.
    const TWO_CYCLES_WITH_GAP = [
      { label: "Cycle 1", startDay: 0, endDay: 5 },
      { label: "Cycle 2", startDay: 14, endDay: 19 },
    ];

    it("excludes inter-cycle cooldown weekdays from the actual-elapsed count", () => {
      // Done issue spans both cycles and the cooldown gap between them.
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 10, daysSpent: 10,
          startDay: 0, endDay: 19, done: true, stateType: "completed",
        }),
      ];
      // Without cycles: working days in [0, 19) = 15 (3 weeks of weekdays).
      // With cycles: 5 days in Cycle 1 + 5 days in Cycle 2 = 10 schedulable. 5 cooldown weekdays excluded.
      const summary = buildMilestoneSummary(issues, JUNE16, 1, TWO_CYCLES_WITH_GAP);
      expect(summary.soFarCount).toBe("1 issue · 10 / ~10 working days");
      expect(summary.soFarStatus).toBe("On time");
    });

    it("without cycles, falls back to plain working days (no cooldown to exclude)", () => {
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 10, daysSpent: 10,
          startDay: 0, endDay: 19, done: true, stateType: "completed",
        }),
      ];
      // No cycles passed → 15 plain working days in [0, 19). Theoretical = 10. 5 days behind.
      const summary = buildMilestoneSummary(issues, JUNE16, 1);
      expect(summary.soFarCount).toBe("1 issue · 15 / ~10 working days");
      expect(summary.soFarStatus).toBe("5 days behind");
    });

    it("still excludes weekends and bank holidays when cycles are present", () => {
      // Holiday Mon (Jun 23 isn't a holiday, but use the existing French calendar to verify
      // that even within a cycle, weekends are excluded). Cycle covers a 5-weekday window.
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 3, daysSpent: 3,
          startDay: 0, endDay: 7, done: true, stateType: "completed", // includes 2 weekend days
        }),
      ];
      // [0, 7) = Mon Jun 16 … Sun Jun 22. Weekdays = 5, all inside Cycle 1.
      const summary = buildMilestoneSummary(issues, JUNE16, 1, TWO_CYCLES_WITH_GAP);
      expect(summary.soFarCount).toBe("1 issue · 5 / ~3 working days");
      expect(summary.soFarStatus).toBe("2 days behind");
    });

    it("counts days past the last known cycle as schedulable (matches scheduler behaviour)", () => {
      // Issue extends past Cycle 2's end → those days should be counted, since the
      // scheduler treats past-last-cycle days as freely schedulable.
      const issues = [
        makeScheduledIssue({
          id: "a", identifier: "A-1", estimate: 15, daysSpent: 15,
          startDay: 0, endDay: 26, done: true, stateType: "completed",
        }),
      ];
      // [0, 26) = Jun 16 → Jul 11.
      //   Cycle 1 weekdays (Jun 16-20): 5 schedulable
      //   Cooldown weekdays (Jun 23-27): 0 schedulable (excluded)
      //   Cycle 2 weekdays (Jun 30-Jul 4): 5 schedulable
      //   Past last cycle (Jul 5-11): Jul 7-11 = 5 weekdays, all schedulable (past-last rule)
      //   Total = 15 schedulable.
      const summary = buildMilestoneSummary(issues, JUNE16, 1, TWO_CYCLES_WITH_GAP);
      expect(summary.soFarCount).toBe("1 issue · 15 / ~15 working days");
      expect(summary.soFarStatus).toBe("On time");
    });
  });
});
