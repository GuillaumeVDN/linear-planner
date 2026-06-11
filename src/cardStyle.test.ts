import { describe, it, expect } from "vitest";
import { isBlockedDisplay, canShowRemoveBlockerMenu, wouldDuplicateBlocker } from "./cardStyle";

const blocker = (overrides: { id?: string; identifier?: string; title?: string; done?: boolean; relationId?: string } = {}) => ({
  id: overrides.id ?? "blocker-id",
  identifier: overrides.identifier ?? "B-1",
  title: overrides.title ?? "blocker",
  done: overrides.done ?? false,
  relationId: overrides.relationId ?? "rel-1",
});

describe("isBlockedDisplay", () => {
  const undoneBlocker = blocker({ done: false });
  const doneBlocker = blocker({ id: "B-2", identifier: "B-2", title: "done blocker", done: true, relationId: "rel-2" });

  it("returns true when an unstarted issue has an undone blocker", () => {
    expect(
      isBlockedDisplay({ stateType: "unstarted", done: false, blockedBy: [undoneBlocker] }),
    ).toBe(true);
  });

  it("returns true for a backlog issue with an undone blocker", () => {
    expect(
      isBlockedDisplay({ stateType: "backlog", done: false, blockedBy: [undoneBlocker] }),
    ).toBe(true);
  });

  it("returns false for an ongoing (started) issue, even with undone blockers", () => {
    expect(
      isBlockedDisplay({ stateType: "started", done: false, blockedBy: [undoneBlocker] }),
    ).toBe(false);
  });

  it("returns false for a done issue with undone blockers", () => {
    expect(
      isBlockedDisplay({ stateType: "completed", done: true, blockedBy: [undoneBlocker] }),
    ).toBe(false);
  });

  it("returns false when all blockers are done", () => {
    expect(
      isBlockedDisplay({ stateType: "unstarted", done: false, blockedBy: [doneBlocker] }),
    ).toBe(false);
  });

  it("returns false when there are no blockers", () => {
    expect(
      isBlockedDisplay({ stateType: "unstarted", done: false, blockedBy: [] }),
    ).toBe(false);
  });

  it("returns true when at least one of several blockers is undone", () => {
    expect(
      isBlockedDisplay({ stateType: "unstarted", done: false, blockedBy: [doneBlocker, undoneBlocker] }),
    ).toBe(true);
  });
});

describe("canShowRemoveBlockerMenu", () => {
  it("returns false when writes are disabled", () => {
    expect(canShowRemoveBlockerMenu({ blockedBy: [blocker()] }, false)).toBe(false);
  });

  it("returns false when the issue has no blockers (nothing to remove)", () => {
    expect(canShowRemoveBlockerMenu({ blockedBy: [] }, true)).toBe(false);
  });

  it("returns true when writes are enabled and the issue has at least one blocker", () => {
    expect(canShowRemoveBlockerMenu({ blockedBy: [blocker()] }, true)).toBe(true);
  });

  it("includes done blockers — removing a satisfied dependency is still a valid action", () => {
    const doneB = blocker({ id: "x", done: true, relationId: "rel-x" });
    expect(canShowRemoveBlockerMenu({ blockedBy: [doneB] }, true)).toBe(true);
  });
});

describe("wouldDuplicateBlocker", () => {
  it("returns true when the target id is already in source.blockedBy", () => {
    const target = { id: "B" };
    const source = { blockedBy: [blocker({ id: "B" })] };
    expect(wouldDuplicateBlocker(source, target)).toBe(true);
  });

  it("returns false when the target is unrelated", () => {
    const target = { id: "C" };
    const source = { blockedBy: [blocker({ id: "B" })] };
    expect(wouldDuplicateBlocker(source, target)).toBe(false);
  });

  it("returns false when source has no blockers", () => {
    const target = { id: "B" };
    const source = { blockedBy: [] };
    expect(wouldDuplicateBlocker(source, target)).toBe(false);
  });

  it("matches by id, not identifier — protects against stale identifier collisions", () => {
    // Same human-readable identifier but different internal id → not a duplicate.
    const target = { id: "different-uuid" };
    const source = { blockedBy: [blocker({ id: "B-uuid", identifier: "FIN-1" })] };
    expect(wouldDuplicateBlocker(source, target)).toBe(false);
  });
});
