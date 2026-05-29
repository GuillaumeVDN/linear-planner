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
  let count = 0;
  for (let d = startCalDay; d < endCalDay; d++) {
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

  if (startedIssues.length > 0) {
    const doneIssues = estimatedIssues.filter((i) => i.done);
    const doneEstimateTotal = doneIssues.reduce((s, i) => s + i.estimate, 0);
    // Theoretical schedule: how long the done issues WOULD take if scheduled cleanly
    // with W workers respecting dependencies (and ignoring their real Linear dates).
    // Compared against actual wall-clock elapsed, this rewards extra parallelism
    // and accounts for dependency chains that constrain achievable wall-clock.
    let theoreticalElapsed = 0;
    let actualElapsed = 0;
    if (doneIssues.length > 0) {
      const doneIdByIdentifier = new Map(doneIssues.map((i) => [i.identifier, i.id]));
      const theoreticalInput = doneIssues.map((i) => ({
        id: i.id,
        estimate: i.estimate,
        blockedBy: i.blockedBy
          .map((b) => doneIdByIdentifier.get(b.identifier))
          .filter((id): id is string => !!id),
      }));
      theoreticalElapsed = theoreticalSchedule(theoreticalInput, w);
      const minStart = Math.min(...doneIssues.map((i) => i.startDay));
      const maxEnd = Math.max(...doneIssues.map((i) => i.endDay));
      actualElapsed = schedulableDaysBetween(minStart, maxEnd, startDate, cycles);
    }
    const fmtActual = actualElapsed % 1 === 0 ? `${actualElapsed}` : actualElapsed.toFixed(1);
    const fmtTheoretical = theoreticalElapsed % 1 === 0 ? `${theoreticalElapsed}` : theoreticalElapsed.toFixed(1);
    soFarLabel = "Completed";
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
    const fmtSpentOngoing = totalSpent % 1 === 0 ? `${totalSpent}` : totalSpent.toFixed(1);
    ongoingCount = `${allOngoingCount} issue${allOngoingCount !== 1 ? "s" : ""} · ${fmtSpentOngoing} / ~${totalOngoingEstimate} working days`;
    const diff = totalSpent - totalOngoingEstimate;
    if (diff > 0) {
      ongoingColor = "#f97316";
      ongoingStatus = `${diff} day${diff !== 1 ? "s" : ""} behind`;
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
    soFarLabel, soFarCount, soFarDays, soFarStatus, soFarColor,
    ongoingLabel, ongoingCount, ongoingStatus, ongoingColor,
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
      {summary.soFarLabel && (
        <>
          <div style={spacerStyle} />
          <span style={boldLineStyle}>{summary.soFarLabel}</span>
          <span style={indentLineStyle}>{summary.soFarCount}</span>
          <span style={{ ...indentLineStyle, color: summary.soFarColor ?? "var(--text-muted)", fontWeight: 600 }}>{summary.soFarStatus}</span>
        </>
      )}
      {summary.ongoingLabel && (
        <>
          <div style={spacerStyle} />
          <span style={boldLineStyle}>{summary.ongoingLabel}</span>
          <span style={indentLineStyle}>{summary.ongoingCount}</span>
          <span style={{ ...indentLineStyle, color: summary.ongoingColor ?? "var(--text-muted)", fontWeight: 600 }}>{summary.ongoingStatus}</span>
        </>
      )}
      {summary.targetEnd && (
        <>
          <div style={spacerStyle} />
          <span style={boldLineStyle}>Unstarted</span>
          {summary.targetDays && <span style={indentLineStyle}>{summary.targetDays}</span>}
          <span style={indentLineStyle}>{summary.targetEnd}</span>
        </>
      )}
    </>
  );
}
