import { describe, it, expect } from "vitest";
import { buildMilestoneSummary, elapsedWorkingDays, theoreticalWorkingDays } from "./MilestoneHeader";
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

/**
 * The Global bar and the Completed section must speak the same language: both are wall-clock
 * working days, never summed per-issue effort. These lock the two helpers they share.
 */
describe("global vs completed elapsed maths", () => {
  const done = [
    makeScheduledIssue({ id: "a", identifier: "A-1", estimate: 5, daysSpent: 5, startDay: 0, endDay: 4, done: true, stateType: "completed" }),
    makeScheduledIssue({ id: "b", identifier: "A-2", estimate: 5, daysSpent: 7, startDay: 0, endDay: 4, done: true, stateType: "completed" }),
  ];
  const ongoing = makeScheduledIssue({ id: "c", identifier: "A-3", estimate: 4, daysSpent: 2, startDay: 2, endDay: 4, stateType: "started" });
  const unstarted = makeScheduledIssue({ id: "d", identifier: "A-4", estimate: 6, startDay: 10, endDay: 16 });

  it("reports elapsed span, not the sum of per-issue days", () => {
    // Summing daysSpent would give 12; the two bars ran in parallel over 4 calendar days,
    // which is 4 working days from the Monday start.
    expect(elapsedWorkingDays(done, MONDAY, [])).toBe(4);
  });

  it("gives Global the same elapsed figure as Completed when only done issues have run", () => {
    const summary = buildMilestoneSummary(done, MONDAY, 2);
    const globalElapsed = elapsedWorkingDays(done.filter((i) => i.daysSpent != null), MONDAY, []);
    // Completed renders "<elapsed> / ~<theoretical>" — the Global line must start with the same number.
    expect(summary.soFarCount).toBe(`2 issues · ${globalElapsed} / ~5 working days`);
  });

  it("counts an ongoing issue in the elapsed span but not the done-only one", () => {
    const worked = [...done, ongoing];
    // The ongoing bar ends on the same day, so the span is unchanged here.
    expect(elapsedWorkingDays(worked, MONDAY, [])).toBe(4);
    // A longer ongoing bar does extend it: days 0..8 from a Monday span a weekend,
    // so 8 calendar days count as 6 working ones.
    const later = makeScheduledIssue({ id: "e", identifier: "A-5", estimate: 2, daysSpent: 2, startDay: 4, endDay: 8, stateType: "started" });
    expect(elapsedWorkingDays([...done, later], MONDAY, [])).toBe(6);
  });

  it("spreads the whole backlog over the configured workers for the theoretical target", () => {
    const estimated = [...done, ongoing, unstarted];
    // 5 + 5 + 4 + 6 = 20 points of work over 2 workers → 10 working days.
    expect(theoreticalWorkingDays(estimated, 2)).toBe(10);
    // With a single worker there is no parallelism to exploit.
    expect(theoreticalWorkingDays(estimated, 1)).toBe(20);
  });

  it("respects dependencies inside the set rather than dividing blindly", () => {
    const first = makeScheduledIssue({ id: "x", identifier: "X-1", estimate: 4 });
    const second = makeScheduledIssue({
      id: "y", identifier: "X-2", estimate: 4,
      blockedBy: [{ id: "x", identifier: "X-1", title: "X-1", done: false, relationId: "r1" }],
    });
    // A chain cannot be parallelised: 8 days even with 2 workers.
    expect(theoreticalWorkingDays([first, second], 2)).toBe(8);
  });
});
