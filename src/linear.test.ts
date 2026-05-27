import { describe, it, expect } from "vitest";
import { isPlannableIssue } from "./linear";

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
