import { describe, it, expect } from "vitest";
import { isBlockedDisplay } from "./cardStyle";

describe("isBlockedDisplay", () => {
  const undoneBlocker = { identifier: "B-1", title: "blocker", done: false };
  const doneBlocker = { identifier: "B-2", title: "done blocker", done: true };

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
