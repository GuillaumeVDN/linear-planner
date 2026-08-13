import { type CSSProperties } from "react";
import type { ScheduledIssue, CyclePeriod } from "./scheduler";
import { dayToDate, formatDate, isNonWorkingDay } from "./workingDays";
import { theoreticalSchedule } from "./theoreticalSchedule";

/**
 * Count *schedulable* days in [startCalDay, endCalDay): working days that are also
 * inside one of the configured cycles. Days falling in inter-cycle cooldown gaps
 * are excluded, matching what the scheduler treats as "non-schedulable".
 * If no cycles are configured, all working days are schedulable.
 */
function schedulableDaysBetween(
  startCalDay: number,
  endCalDay: number,
  chartStart: Date,
  cycles: CyclePeriod[],
): number {
  if (endCalDay <= startCalDay) return 0;
  const lastCycleEnd = cycles.length > 0 ? Math.max(...cycles.map((c) => c.endDay)) : -Infinity;
  // start/end can be fractional (.5 = PM). Walk every integer day the range touches.
  const startInt = Math.floor(startCalDay);
  const endIntExclusive = Math.ceil(endCalDay);
  let count = 0;
  for (let d = startInt; d < endIntExclusive; d++) {
    if (isNonWorkingDay(dayToDate(chartStart, d))) continue;
    if (cycles.length > 0 && d < lastCycleEnd) {
      // Inside the known-cycle range: only count days that fall within some cycle.
      const inCycle = cycles.some((c) => d >= c.startDay && d < c.endDay);
      if (!inCycle) continue;
    }
    count++;
  }
  return count;
}

/**
 * Wall-clock working days actually spanned by a set of bars: first start → last end.
 * Idle stretches and overlaps are included — this is elapsed time, not summed effort.
 */
export function elapsedWorkingDays(issues: ScheduledIssue[], startDate: Date, cycles: CyclePeriod[]): number {
  if (issues.length === 0) return 0;
  const minStart = Math.min(...issues.map((i) => i.startDay));
  const maxEnd = Math.max(...issues.map((i) => i.endDay));
  return schedulableDaysBetween(minStart, maxEnd, startDate, cycles);
}

/**
 * Wall-clock working days the same issues WOULD take scheduled cleanly on `numWorkers`,
 * respecting the dependencies that exist within the set and ignoring their real Linear
 * dates. Compared against `elapsedWorkingDays`, this rewards extra parallelism and accounts
 * for dependency chains that cap the achievable wall-clock.
 */
export function theoreticalWorkingDays(issues: ScheduledIssue[], numWorkers: number): number {
  const idByIdentifier = new Map(issues.map((i) => [i.identifier, i.id]));
  return theoreticalSchedule(
    issues.map((i) => ({
      id: i.id,
      estimate: i.estimate,
      blockedBy: i.blockedBy
        .map((b) => idByIdentifier.get(b.identifier))
        .filter((id): id is string => !!id),
    })),
    Math.max(1, numWorkers),
  );
}

export interface MilestoneSummaryData {
  issueCount: string;
  totalDays: string | null;
  startedAt: string | null;
  targetDays: string;
  targetEnd: string;
  soFarLabel: string | null;
  soFarCount: string | null;
  soFarDays: string | null;
  soFarStatus: string | null;
  soFarColor: string | null;
  ongoingLabel: string | null;
  ongoingCount: string | null;
  ongoingStatus: string | null;
  ongoingColor: string | null;
}

export function buildMilestoneSummary(
  msIssues: ScheduledIssue[],
  startDate: Date,
  numWorkers: number = 1,
  cycles: CyclePeriod[] = [],
  // The "ahead/behind/on time" progress lines compare against the configured number of
  // workers in parallel. That comparison only makes sense globally (across all issues) —
  // per-milestone it's misleading once people split their time across milestones. So
  // callers can opt out of the status lines while keeping the counts.
  includeStatus: boolean = true,
): MilestoneSummaryData {
  const count = msIssues.length;
  const empty: MilestoneSummaryData = { issueCount: `${count} issue${count !== 1 ? "s" : ""}`, totalDays: null, startedAt: null, targetDays: "", targetEnd: "", soFarLabel: null, soFarCount: null, soFarDays: null, soFarStatus: null, soFarColor: null, ongoingLabel: null, ongoingCount: null, ongoingStatus: null, ongoingColor: null };
  if (count === 0) return { ...empty, issueCount: "0 issues" };

  const estimatedIssues = msIssues.filter((i) => i.hasEstimate);
  if (estimatedIssues.length === 0) return empty;

  const minStartDay = Math.min(...estimatedIssues.map((i) => i.startDay));
  const maxEndDay = Math.max(...estimatedIssues.map((i) => i.endDay));

  const hasStarted = estimatedIssues.some((i) => i.stateType === "started" || i.done);
  const allDone = estimatedIssues.every((i) => i.done);
  const endStr = allDone
    ? formatDate(dayToDate(startDate, maxEndDay - 1))
    : `~${formatDate(dayToDate(startDate, maxEndDay - 1))}`;

  const w = Math.max(1, numWorkers);
  const fmtDays = (d: number) => { const v = d / w; return v % 1 === 0 ? `${v}` : v.toFixed(1); };

  const totalEstimate = estimatedIssues.reduce((s, i) => s + i.estimate, 0);

  const startedAt = hasStarted ? `Started: ${formatDate(dayToDate(startDate, minStartDay))}` : null;

  const startedIssues = estimatedIssues.filter((i) => i.daysSpent != null);
  let soFarLabel: string | null = null;
  let soFarCount: string | null = null;
  let soFarDays: string | null = null;
  let soFarStatus: string | null = null;
  let soFarColor: string | null = null;

  const doneIssues = estimatedIssues.filter((i) => i.done);
  if (startedIssues.length > 0 && doneIssues.length > 0) {
    const theoreticalElapsed = theoreticalWorkingDays(doneIssues, w);
    const actualElapsed = elapsedWorkingDays(doneIssues, startDate, cycles);
    const fmtActual = actualElapsed % 1 === 0 ? `${actualElapsed}` : actualElapsed.toFixed(1);
    const fmtTheoretical = theoreticalElapsed % 1 === 0 ? `${theoreticalElapsed}` : theoreticalElapsed.toFixed(1);
    const donePct = Math.round((msIssues.filter((i) => i.done).length / count) * 100);
    soFarLabel = `Completed (${donePct}%)`;
    soFarCount = `${doneIssues.length} issue${doneIssues.length !== 1 ? "s" : ""} · ${fmtActual} / ~${fmtTheoretical} working days`;
    const diff = actualElapsed - theoreticalElapsed;
    const fmtAbsDiff = Math.abs(diff) % 1 === 0 ? `${Math.abs(diff)}` : Math.abs(diff).toFixed(1);
    if (diff > 0) {
      soFarColor = "#f97316";
      soFarStatus = `${fmtAbsDiff} days behind`;
    } else if (diff < 0) {
      soFarColor = "#22c55e";
      soFarStatus = `${fmtAbsDiff} days ahead`;
    } else {
      soFarColor = "#15803d";
      soFarStatus = "On time";
    }
  }

  const ongoingIssues = estimatedIssues.filter((i) => !i.done && i.daysSpent != null);
  let ongoingLabel: string | null = null;
  let ongoingCount: string | null = null;
  let ongoingStatus: string | null = null;
  let ongoingColor: string | null = null;

  if (ongoingIssues.length > 0) {
    const totalSpent = ongoingIssues.reduce((s, i) => s + (i.daysSpent ?? 0), 0);
    const totalOngoingEstimate = ongoingIssues.reduce((s, i) => s + i.estimate, 0);
    const allOngoingCount = msIssues.filter((i) => !i.done && i.daysSpent != null).length;
    ongoingLabel = "Ongoing";
    // Per-person days divided by W, like the total and remaining lines — otherwise this block
    // reads in a different unit from the rest of the bar and the figures refuse to add up.
    ongoingCount = `${allOngoingCount} issue${allOngoingCount !== 1 ? "s" : ""} · ${fmtDays(totalSpent)} / ~${fmtDays(totalOngoingEstimate)} working days`;
    const diff = (totalSpent - totalOngoingEstimate) / w;
    if (diff > 0) {
      ongoingColor = "#f97316";
      const fmtDiff = diff % 1 === 0 ? `${diff}` : diff.toFixed(1);
      ongoingStatus = `${fmtDiff} day${diff !== 1 ? "s" : ""} behind`;
    } else {
      ongoingColor = "#15803d";
      ongoingStatus = "On time";
    }
  }

  const totalDaysStr = `~${fmtDays(totalEstimate)} working days`;

  const allDoneCount = msIssues.filter((i) => i.done).length;
  const allOngoingForUnstarted = msIssues.filter((i) => !i.done && i.daysSpent != null).length;
  const doneEstimate = estimatedIssues.filter((i) => i.done).reduce((s, i) => s + i.estimate, 0);
  const ongoingEstimate = ongoingIssues.reduce((s, i) => s + i.estimate, 0);
  const unstartedCount = count - allDoneCount - allOngoingForUnstarted;
  const unstartedEstimate = totalEstimate - doneEstimate - ongoingEstimate;
  const unstartedStr = unstartedEstimate > 0 ? `${unstartedCount} issue${unstartedCount !== 1 ? "s" : ""} · ~${fmtDays(unstartedEstimate)} working days` : "";

  return {
    issueCount: `${count} issues`,
    totalDays: totalDaysStr,
    startedAt,
    targetDays: unstartedStr,
    targetEnd: `End: ${endStr}`,
    soFarLabel, soFarCount, soFarDays,
    soFarStatus: includeStatus ? soFarStatus : null,
    soFarColor: includeStatus ? soFarColor : null,
    ongoingLabel, ongoingCount,
    ongoingStatus: includeStatus ? ongoingStatus : null,
    ongoingColor: includeStatus ? ongoingColor : null,
  };
}

const lineStyle: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-muted)" };
const boldLineStyle: CSSProperties = { ...lineStyle, fontWeight: 600 };
const indentLineStyle: CSSProperties = { ...lineStyle, paddingLeft: 8 };
const spacerStyle: CSSProperties = { height: 3 };

export function MilestoneHeader({ name, summary }: { name: string; summary: MilestoneSummaryData }) {
  return (
    <>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--iteration-line)" }} title={name}>
        {name}
      </span>
      <span style={boldLineStyle}>{summary.issueCount}{summary.totalDays ? ` · ${summary.totalDays}` : ""}</span>
      {summary.startedAt && <span style={lineStyle}>{summary.startedAt}</span>}
      {summary.ongoingLabel && (
        <>
          <div style={spacerStyle} />
          <span style={boldLineStyle}>{summary.ongoingLabel}</span>
          <span style={indentLineStyle}>{summary.ongoingCount}</span>
          {summary.ongoingStatus && <span style={{ ...indentLineStyle, color: summary.ongoingColor ?? "var(--text-muted)", fontWeight: 600 }}>{summary.ongoingStatus}</span>}
        </>
      )}
      {summary.targetEnd && (
        <>
          <div style={spacerStyle} />
          <span style={boldLineStyle}>Remaining</span>
          {summary.targetDays && <span style={indentLineStyle}>{summary.targetDays}</span>}
          <span style={indentLineStyle}>{summary.targetEnd}</span>
        </>
      )}
      {summary.soFarLabel && (
        <>
          <div style={spacerStyle} />
          <span style={boldLineStyle}>{summary.soFarLabel}</span>
          <span style={indentLineStyle}>{summary.soFarCount}</span>
          {summary.soFarStatus && <span style={{ ...indentLineStyle, color: summary.soFarColor ?? "var(--text-muted)", fontWeight: 600 }}>{summary.soFarStatus}</span>}
        </>
      )}
    </>
  );
}
