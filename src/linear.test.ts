import { describe, it, expect } from "vitest";
import { isPlannableIssue, parseNoCountRanges } from "./linear";

function withLabels(...names: string[]) {
  return { labels: { nodes: names.map((name) => ({ name, color: "#ccc" })) } };
}

describe("isPlannableIssue", () => {
  it("includes issues with no labels", () => {
    expect(isPlannableIssue(withLabels())).toBe(true);
  });

  it("includes issues with unrelated labels", () => {
    expect(isPlannableIssue(withLabels("bug", "frontend"))).toBe(true);
  });

  it("excludes issues tagged no-planner", () => {
    expect(isPlannableIssue(withLabels("no-planner"))).toBe(false);
  });

  it("excludes issues with no-planner among other labels", () => {
    expect(isPlannableIssue(withLabels("bug", "no-planner"))).toBe(false);
  });
});

describe("parseNoCountRanges", () => {
  it("parses a single range from the documented format", () => {
    expect(parseNoCountRanges("planner-no-count: 2026-06-10-AM, 2026-06-12-PM")).toEqual([
      { startDate: "2026-06-10", startPm: false, endDate: "2026-06-12", endPm: true },
    ]);
  });

  it("is case-insensitive on the directive and the AM/PM half", () => {
    expect(parseNoCountRanges("Planner-No-Count: 2026-06-10-am, 2026-06-10-pm")).toEqual([
      { startDate: "2026-06-10", startPm: false, endDate: "2026-06-10", endPm: true },
    ]);
  });

  it("ignores lines and comments without the directive", () => {
    expect(parseNoCountRanges("just a normal comment about 2026-06-10-AM")).toEqual([]);
  });

  it("supports multiple ranges across lines and pairs", () => {
    const body = [
      "planner-no-count: 2026-06-10-AM, 2026-06-12-PM",
      "some prose",
      "planner-no-count: 2026-07-01-PM, 2026-07-02-AM, 2026-07-05-AM, 2026-07-05-PM",
    ].join("\n");
    expect(parseNoCountRanges(body)).toEqual([
      { startDate: "2026-06-10", startPm: false, endDate: "2026-06-12", endPm: true },
      { startDate: "2026-07-01", startPm: true, endDate: "2026-07-02", endPm: false },
      { startDate: "2026-07-05", startPm: false, endDate: "2026-07-05", endPm: true },
    ]);
  });

  it("ignores a dangling unpaired token", () => {
    expect(parseNoCountRanges("planner-no-count: 2026-06-10-AM")).toEqual([]);
  });
});
