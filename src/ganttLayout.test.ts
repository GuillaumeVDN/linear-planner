import { describe, it, expect } from "vitest";
import { crossedNonWorkingRuns } from "./ganttLayout";

// Days 0–4 and 7–11 are worked; 5–6 is a weekend, 12–15 a cooldown, 16–20 worked.
const NON_WORKING = new Set([5, 6, 12, 13, 14, 15]);
const isNonWorking = (day: number) => NON_WORKING.has(day);

describe("crossedNonWorkingRuns", () => {
  it("reports a weekend the bar runs through", () => {
    expect(crossedNonWorkingRuns(3, 9, isNonWorking)).toEqual([[5, 6]]);
  });

  it("reports a cooldown the bar runs through", () => {
    expect(crossedNonWorkingRuns(10, 18, isNonWorking)).toEqual([[12, 15]]);
  });

  it("reports every run a long bar crosses", () => {
    expect(crossedNonWorkingRuns(2, 18, isNonWorking)).toEqual([[5, 6], [12, 15]]);
  });

  it("reports nothing for a bar that ends inside a run", () => {
    expect(crossedNonWorkingRuns(10, 13.5, isNonWorking)).toEqual([]);
  });

  it("reports nothing for a bar that starts inside a run", () => {
    expect(crossedNonWorkingRuns(13, 18, isNonWorking)).toEqual([]);
  });

  it("reports nothing for a bar wholly inside worked days", () => {
    expect(crossedNonWorkingRuns(1, 4, isNonWorking)).toEqual([]);
  });

  it("reports nothing when every day is worked", () => {
    expect(crossedNonWorkingRuns(0, 20, () => false)).toEqual([]);
  });
});
