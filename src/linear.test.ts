import { describe, it, expect } from "vitest";
import { isPlannableIssue, parseNoCountRanges, endDateFromTransitions, addBlocksRelation, removeRelation } from "./linear";
import type { LinearIssue } from "./linear";

function withLabels(...names: string[]) {
  return {
    labels: { nodes: names.map((name) => ({ name, color: "#ccc" })) },
    state: { name: "In Progress", type: "started", color: "#ccc", position: 1 },
  };
}

function withState(name: string) {
  return { labels: { nodes: [] }, state: { name, type: "started", color: "#ccc", position: 1 } };
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

  it("excludes issues in the Duplicate state", () => {
    expect(isPlannableIssue(withState("Duplicate"))).toBe(false);
  });

  it("includes issues in other states", () => {
    expect(isPlannableIssue(withState("Done"))).toBe(true);
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

function makeIssue(overrides: Partial<LinearIssue> & { id: string; identifier: string }): LinearIssue {
  return {
    title: overrides.identifier,
    url: `https://linear.app/${overrides.identifier}`,
    estimate: null,
    priority: 0,
    priorityLabel: "No priority",
    startedAt: null,
    completedAt: null,
    state: { name: "To do", type: "unstarted", color: "#ccc", position: 1 },
    assignee: null,
    projectMilestone: null,
    labels: { nodes: [] },
    relations: { nodes: [] },
    ...overrides,
  };
}

describe("addBlocksRelation", () => {
  it("adds a blocks relation on the blocker issue pointing at the blocked one", () => {
    const issues = [makeIssue({ id: "a", identifier: "A-1" }), makeIssue({ id: "b", identifier: "A-2" })];
    const next = addBlocksRelation(issues, "a", "b", "rel-1");
    const blocker = next.find((i) => i.id === "a")!;
    expect(blocker.relations.nodes).toEqual([
      { id: "rel-1", type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } },
    ]);
    // The blocked issue is untouched (relation lives on the blocker, per the scheduler).
    expect(next.find((i) => i.id === "b")!.relations.nodes).toEqual([]);
  });

  it("does not mutate the input array or issue objects", () => {
    const issues = [makeIssue({ id: "a", identifier: "A-1" }), makeIssue({ id: "b", identifier: "A-2" })];
    const next = addBlocksRelation(issues, "a", "b", "rel-1");
    expect(issues[0].relations.nodes).toEqual([]);
    expect(next).not.toBe(issues);
    // Unaffected issues keep their identity (no needless re-render churn).
    expect(next.find((i) => i.id === "b")).toBe(issues[1]);
  });

  it("is a no-op when the same blocks relation already exists", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "A-1", relations: { nodes: [{ id: "rel-old", type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] } }),
      makeIssue({ id: "b", identifier: "A-2" }),
    ];
    const next = addBlocksRelation(issues, "a", "b", "rel-new");
    expect(next.find((i) => i.id === "a")!.relations.nodes).toHaveLength(1);
    expect(next.find((i) => i.id === "a")!.relations.nodes[0].id).toBe("rel-old");
  });

  it("falls back to an empty identifier when the blocked issue is absent", () => {
    const issues = [makeIssue({ id: "a", identifier: "A-1" })];
    const next = addBlocksRelation(issues, "a", "missing", "rel-1");
    expect(next.find((i) => i.id === "a")!.relations.nodes[0].relatedIssue).toEqual({ id: "missing", identifier: "" });
  });
});

describe("removeRelation", () => {
  it("drops the relation node with the matching id", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "A-1", relations: { nodes: [{ id: "rel-1", type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] } }),
      makeIssue({ id: "b", identifier: "A-2" }),
    ];
    const next = removeRelation(issues, "rel-1");
    expect(next.find((i) => i.id === "a")!.relations.nodes).toEqual([]);
  });

  it("only copies issues that held the relation, leaving others by identity", () => {
    const issues = [
      makeIssue({ id: "a", identifier: "A-1", relations: { nodes: [{ id: "rel-1", type: "blocks", relatedIssue: { id: "b", identifier: "A-2" } }] } }),
      makeIssue({ id: "b", identifier: "A-2" }),
    ];
    const next = removeRelation(issues, "rel-1");
    expect(next.find((i) => i.id === "a")).not.toBe(issues[0]);
    expect(next.find((i) => i.id === "b")).toBe(issues[1]);
  });

  it("is a no-op when no relation matches", () => {
    const issues = [makeIssue({ id: "a", identifier: "A-1" })];
    const next = removeRelation(issues, "nope");
    expect(next[0]).toBe(issues[0]);
  });
});

describe("endDateFromTransitions", () => {
  const stateOf = (name: string) => ({ name, type: "started", position: 1 });
  const transitions = [
    { createdAt: "2025-04-07T08:00:00.000Z", fromState: null, toState: stateOf("In Progress") },
    { createdAt: "2025-04-08T08:00:00.000Z", fromState: stateOf("In Progress"), toState: stateOf("Merged") },
    { createdAt: "2025-04-09T08:00:00.000Z", fromState: stateOf("Merged"), toState: stateOf("In Progress") },
    { createdAt: "2025-04-10T08:00:00.000Z", fromState: stateOf("In Progress"), toState: stateOf("Merged") },
  ];

  it("returns the most recent entry into the end state", () => {
    expect(endDateFromTransitions(transitions, "Merged")).toBe("2025-04-10T08:00:00.000Z");
  });

  it("returns null when the issue never entered the end state", () => {
    expect(endDateFromTransitions(transitions, "Released")).toBe(null);
  });

  it("returns null without an end state name", () => {
    expect(endDateFromTransitions(transitions, "")).toBe(null);
  });
});
