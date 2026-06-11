import type { ScheduledIssue } from "./scheduler";

export const BLOCKED_STRIPE =
  "repeating-linear-gradient(-45deg, transparent 0px, transparent 5px, rgba(150,150,150,0.15) 5px, rgba(150,150,150,0.15) 10px)";
export const NO_ESTIMATE_BG =
  "repeating-linear-gradient(-45deg, transparent, transparent 5px, rgba(234,145,50,0.13) 5px, rgba(234,145,50,0.13) 10px)";
export const DONE_STRIPE =
  "repeating-linear-gradient(-45deg, transparent 0px, transparent 5px, rgba(74,222,128,0.18) 5px, rgba(74,222,128,0.18) 10px)";

/** Convert hex color (#rgb or #rrggbb) to rgba with the given alpha. Returns fallback if parse fails. */
export function hexToRgba(hex: string, alpha: number, fallback = "var(--surface-hover)"): string {
  if (!hex || hex[0] !== "#") return fallback;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return fallback;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return fallback;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Background tint for a ScheduledIssue's current status — ongoing only. Returns null otherwise. */
export function ongoingStatusBg(stateType: string, done: boolean, stateColor: string): string | null {
  if (done) return null;
  if (stateType !== "started") return null;
  return hexToRgba(stateColor, 0.15);
}

/**
 * Whether an issue should be displayed as blocked (lock icon + striped background).
 * Ongoing issues (started, not done) are NOT shown as blocked even if they have undone blockers —
 * work has visibly begun anyway.
 */
export function isBlockedDisplay(issue: Pick<ScheduledIssue, "stateType" | "done" | "blockedBy">): boolean {
  if (issue.done) return false;
  if (issue.stateType === "started") return false;
  return issue.blockedBy.some((b) => !b.done);
}

/**
 * Whether right-clicking the card should open the "remove blocker" context menu.
 * Only relevant when writes are enabled and the issue actually has blockers to remove.
 */
export function canShowRemoveBlockerMenu(
  issue: Pick<ScheduledIssue, "blockedBy">,
  writeEnabled: boolean,
): boolean {
  return writeEnabled && issue.blockedBy.length > 0;
}

/**
 * Whether dragging `source` onto `target` would duplicate an existing "blocked by" relation
 * (target already blocks source). Used to disallow the drop visually + functionally so we
 * don't send Linear a redundant mutation.
 */
export function wouldDuplicateBlocker(
  source: Pick<ScheduledIssue, "blockedBy">,
  target: Pick<ScheduledIssue, "id">,
): boolean {
  return source.blockedBy.some((b) => b.id === target.id);
}
