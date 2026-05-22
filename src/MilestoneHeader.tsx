import { type CSSProperties } from "react";
import type { ScheduledIssue } from "./scheduler";
import { dayToDate, formatDate } from "./workingDays";

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

export function buildMilestoneSummary(msIssues: ScheduledIssue[], startDate: Date, numWorkers: number = 1): MilestoneSummaryData {
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
    const totalDaysSpent = doneIssues.reduce((s, i) => s + (i.daysSpent ?? 0), 0);
    const estimatedPerWorker = doneEstimateTotal / w;
    const spentPerWorker = totalDaysSpent / w;
    const fmtSpent = spentPerWorker % 1 === 0 ? `${spentPerWorker}` : spentPerWorker.toFixed(1);
    soFarLabel = "Completed";
    soFarCount = `${doneIssues.length} issue${doneIssues.length !== 1 ? "s" : ""} · ${fmtSpent} / ~${fmtDays(doneEstimateTotal)} working days`;
    const diff = spentPerWorker - estimatedPerWorker;
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
