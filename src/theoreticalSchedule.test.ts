import { describe, it, expect } from "vitest";
import { theoreticalSchedule } from "./theoreticalSchedule";

describe("theoreticalSchedule", () => {
  it("returns 0 for an empty input", () => {
    expect(theoreticalSchedule([], 2)).toBe(0);
  });

  it("single issue: estimate is the result regardless of worker count", () => {
    const issues = [{ id: "a", estimate: 7, blockedBy: [] }];
    expect(theoreticalSchedule(issues, 1)).toBe(7);
    expect(theoreticalSchedule(issues, 4)).toBe(7);
  });

  it("two independent issues with W=1 → sum", () => {
    const issues = [
      { id: "a", estimate: 5, blockedBy: [] },
      { id: "b", estimate: 3, blockedBy: [] },
    ];
    expect(theoreticalSchedule(issues, 1)).toBe(8);
  });

  it("two independent issues with W=2 → max", () => {
    const issues = [
      { id: "a", estimate: 5, blockedBy: [] },
      { id: "b", estimate: 3, blockedBy: [] },
    ];
    expect(theoreticalSchedule(issues, 2)).toBe(5);
  });

  it("chain of dependencies: serialised even with many workers", () => {
    // A → B → C, each 4 days. Cannot parallelise — total = 12.
    const issues = [
      { id: "a", estimate: 4, blockedBy: [] },
      { id: "b", estimate: 4, blockedBy: ["a"] },
      { id: "c", estimate: 4, blockedBy: ["b"] },
    ];
    expect(theoreticalSchedule(issues, 1)).toBe(12);
    expect(theoreticalSchedule(issues, 5)).toBe(12);
  });

  it("mix of chain + parallel work with W=2", () => {
    // Chain A(5)→B(5) and independent C(3), D(3). W=2.
    // Best plan: worker 1 does A then B (10 days). Worker 2 does C+D (6 days).
    const issues = [
      { id: "a", estimate: 5, blockedBy: [] },
      { id: "b", estimate: 5, blockedBy: ["a"] },
      { id: "c", estimate: 3, blockedBy: [] },
      { id: "d", estimate: 3, blockedBy: [] },
    ];
    expect(theoreticalSchedule(issues, 2)).toBe(10);
  });

  it("ignores blockedBy ids that aren't in the issue set", () => {
    const issues = [
      { id: "a", estimate: 4, blockedBy: ["external-not-in-set"] },
      { id: "b", estimate: 4, blockedBy: [] },
    ];
    expect(theoreticalSchedule(issues, 2)).toBe(4);
  });

  it("does not infinite-loop on a cycle (bounded safety counter)", () => {
    const issues = [
      { id: "a", estimate: 3, blockedBy: ["b"] },
      { id: "b", estimate: 3, blockedBy: ["a"] },
    ];
    // Cycle is unresolvable; returns 0 (nothing scheduled) rather than hanging.
    expect(theoreticalSchedule(issues, 2)).toBe(0);
  });

  it("with W workers, fully parallel small jobs spread across all workers", () => {
    // 4 independent jobs of 5 days each, W=2 → 2 workers, 2 jobs each = 10 days
    const issues = [
      { id: "a", estimate: 5, blockedBy: [] },
      { id: "b", estimate: 5, blockedBy: [] },
      { id: "c", estimate: 5, blockedBy: [] },
      { id: "d", estimate: 5, blockedBy: [] },
    ];
    expect(theoreticalSchedule(issues, 2)).toBe(10);
    expect(theoreticalSchedule(issues, 4)).toBe(5);
  });
});
