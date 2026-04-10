import { useMemo, useRef, useEffect, useState } from "react";
import type { ScheduleResult, ScheduledIssue, CyclePeriod } from "./scheduler";
import { dayToDate, formatDate, isBankHoliday } from "./scheduler";
import { StatusCircle, BlockedIcon, PriorityIcon, AssigneeAvatar, Legend, buildMilestoneSummary, BLOCKED_STRIPE, NO_ESTIMATE_BG } from "./StatusCircle";

const ROW_HEIGHT = 36;
const ROW_GAP = 4;
const CYCLE_ROW_HEIGHT = 22;
const DATE_ROW_HEIGHT = 50;
const HEADER_HEIGHT = CYCLE_ROW_HEIGHT + DATE_ROW_HEIGHT;
const SEPARATOR_HEIGHT = 52;
const DAY_WIDTH = 40;
const LABEL_WIDTH = 220;

const CYCLE_COLORS = [
  "rgba(99, 102, 241, 0.15)",
  "rgba(168, 85, 247, 0.15)",
  "rgba(14, 165, 233, 0.15)",
  "rgba(20, 184, 166, 0.15)",
];

interface MilestoneGroup {
  milestoneId: string | null;
  milestoneName: string;
  workerRows: Array<{ worker: number; issues: ScheduledIssue[] }>;
  summaryText: string;
}

interface DayInfo {
  day: number; // calendar day offset
  col: number; // visual column index
  date: Date;
  isGrayed: boolean; // non-working or outside cycle
  isMonday: boolean;
  isCycleEnd: boolean;
  isCycleStart: boolean;
}

function isOutsideCycles(day: number, cycles: CyclePeriod[]): boolean {
  if (cycles.length === 0) return false;
  return !cycles.some((c) => day >= c.startDay && day < c.endDay);
}

interface GanttChartProps {
  schedule: ScheduleResult;
  showWeekends: boolean;
  showHolidays: boolean;
  showCooldown: boolean;
  setShowWeekends: (v: boolean) => void;
  setShowHolidays: (v: boolean) => void;
  setShowCooldown: (v: boolean) => void;
}

export function GanttChart({ schedule, showWeekends, showHolidays, showCooldown, setShowWeekends, setShowHolidays, setShowCooldown }: GanttChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltipInfo, setTooltipInfo] = useState<{ issue: ScheduledIssue; x: number; y: number } | null>(null);

  const numWorkers = useMemo(() => Math.max(...schedule.issues.map((i) => i.worker), -1) + 1, [schedule]);

  const milestoneGroups = useMemo(() => {
    const groups: MilestoneGroup[] = [];

    function buildWorkerRows(msIssues: ScheduledIssue[]) {
      const workerRows: MilestoneGroup["workerRows"] = [];
      for (let w = 0; w < numWorkers; w++) {
        const issues = msIssues.filter((i) => i.worker === w).sort((a, b) => a.startDay - b.startDay);
        workerRows.push({ worker: w, issues });
      }
      return workerRows;
    }

    for (const ms of schedule.milestones) {
      const msIssues = schedule.issues.filter((i) => i.milestone?.id === ms.id);
      if (msIssues.length === 0) continue;
      groups.push({ milestoneId: ms.id, milestoneName: ms.name, workerRows: buildWorkerRows(msIssues), summaryText: buildMilestoneSummary(msIssues, schedule.startDate) });
    }

    const noMsIssues = schedule.issues.filter((i) => !i.milestone);
    if (noMsIssues.length > 0) {
      groups.push({ milestoneId: null, milestoneName: "No milestone", workerRows: buildWorkerRows(noMsIssues), summaryText: buildMilestoneSummary(noMsIssues, schedule.startDate) });
    }

    return groups;
  }, [schedule, numWorkers]);

  const totalCalendarDays = Math.max(schedule.totalDays, 1);

  // Build all calendar day info
  const allDays = useMemo(() => {
    const days: Array<{
      day: number;
      date: Date;
      isWeekend: boolean;
      isHoliday: boolean;
      isOutsideCycle: boolean;
      isGrayed: boolean;
      isMonday: boolean;
    }> = [];
    for (let d = 0; d < totalCalendarDays; d++) {
      const date = dayToDate(schedule.startDate, d);
      const dow = date.getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isHoliday = isBankHoliday(date);
      const outsideCycle = isOutsideCycles(d, schedule.cycles);
      days.push({
        day: d,
        date,
        isWeekend,
        isHoliday,
        isOutsideCycle: outsideCycle,
        isGrayed: isWeekend || isHoliday || outsideCycle,
        isMonday: dow === 1,
      });
    }
    return days;
  }, [totalCalendarDays, schedule.startDate, schedule.cycles]);

  // Filter to visible days and assign column indices
  const visibleDays: DayInfo[] = useMemo(() => {
    const result: DayInfo[] = [];
    let col = 0;
    let lastVisibleWeek = -1;
    for (const d of allDays) {
      if (!showWeekends && d.isWeekend) continue;
      if (!showHolidays && d.isHoliday) continue;
      if (!showCooldown && d.isOutsideCycle) continue;
      // Compute week number to detect week boundaries even when Monday is hidden
      const weekNum = Math.floor((d.day + dayToDate(schedule.startDate, 0).getDay()) / 7);
      const isWeekStart = lastVisibleWeek >= 0 && weekNum !== lastVisibleWeek;
      lastVisibleWeek = weekNum;
      // isCycleStart: first visible day of a cycle (left border)
      const isCycleStart = schedule.cycles.some((c) => d.day >= c.startDay && d.day < c.endDay && (() => {
        for (let dd = c.startDay; dd < d.day; dd++) {
          const info = allDays[dd];
          if (!info) continue;
          if (!showWeekends && info.isWeekend) continue;
          if (!showHolidays && info.isHoliday) continue;
          if (!showCooldown && info.isOutsideCycle) continue;
          return false;
        }
        return true;
      })());
      // isCycleEnd: first visible day of a cooldown (left border on cooldown start)
      const isCycleEnd = schedule.cycles.some((c) => d.day >= c.endDay && (() => {
        // Check this is the first visible day at or after c.endDay
        for (let dd = c.endDay; dd < d.day; dd++) {
          const info = allDays[dd];
          if (!info) continue;
          if (!showWeekends && info.isWeekend) continue;
          if (!showHolidays && info.isHoliday) continue;
          if (!showCooldown && info.isOutsideCycle) continue;
          return false;
        }
        return true;
      })());
      result.push({ day: d.day, col, date: d.date, isGrayed: d.isGrayed, isMonday: d.isMonday || isWeekStart, isCycleEnd, isCycleStart });
      col++;
    }
    return result;
  }, [allDays, showWeekends, showHolidays, showCooldown]);

  // Map calendar day offset → visual column (or -1 if hidden)
  const dayToCol = useMemo(() => {
    const map = new Array(totalCalendarDays).fill(-1);
    for (const v of visibleDays) map[v.day] = v.col;
    return map;
  }, [visibleDays, totalCalendarDays]);

  // Bar column helpers
  function getBarCols(startDay: number, endDay: number): [number, number] | null {
    let firstCol = -1;
    let lastCol = -1;
    const end = Math.min(endDay, dayToCol.length);
    for (let d = startDay; d < end; d++) {
      const c = dayToCol[d];
      if (c >= 0) {
        if (firstCol < 0) firstCol = c;
        lastCol = c;
      }
    }
    if (firstCol < 0) return null;
    return [firstCol, lastCol + 1];
  }

  const totalVisibleCols = visibleDays.length;
  const chartWidth = totalVisibleCols * DAY_WIDTH;

  const totalVisualRows = useMemo(() => {
    let count = 0;
    for (const group of milestoneGroups) { count += 1 + group.workerRows.length; }
    return count;
  }, [milestoneGroups]);

  const chartContentHeight = milestoneGroups.length * SEPARATOR_HEIGHT + totalVisualRows * (ROW_HEIGHT + ROW_GAP);

  const todayCol = useMemo(() => {
    const to = schedule.todayOffset;
    if (to >= 0 && to < dayToCol.length) return dayToCol[to];
    return -1;
  }, [schedule.todayOffset, dayToCol]);

  useEffect(() => {
    if (containerRef.current && todayCol >= 0) {
      containerRef.current.scrollLeft = Math.max(0, todayCol * DAY_WIDTH - 200);
    }
  }, [todayCol]);

  return (
    <div>
      <Legend issues={schedule.issues} showOptions={{ showWeekends, setShowWeekends, showHolidays, setShowHolidays, showCooldown, setShowCooldown }} />
      {/* Scrollable chart */}
      <div
        ref={containerRef}
        style={{
          overflow: "auto",
          background: "var(--surface)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", minWidth: LABEL_WIDTH + chartWidth }}>
          {/* Left labels */}
          <div
            style={{
              width: LABEL_WIDTH,
              minWidth: LABEL_WIDTH,
              position: "sticky",
              left: 0,
              zIndex: 20,
              background: "var(--surface)",
              borderRight: "1px solid var(--border)",
            }}
          >
            <div style={{ height: HEADER_HEIGHT, borderBottom: "1px solid var(--border)" }} />
            {milestoneGroups.map((group) => (
              <div key={group.milestoneId ?? "none"}>
                <div
                  style={{
                    height: SEPARATOR_HEIGHT,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    padding: "0 12px",
                    borderTop: "2px solid var(--iteration-line)",
                    background: "var(--surface)",
                    overflow: "hidden",
                    gap: 1,
                  }}
                >
                  <span
                    title={group.milestoneName}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--iteration-line)",
                    }}
                  >
                    {group.milestoneName}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 10,
                      color: "var(--text-muted)",
                    }}
                  >
                    {group.summaryText}
                  </span>
                </div>
                {group.workerRows.map((row) => (
                  <div key={row.worker} style={{ height: ROW_HEIGHT + ROW_GAP, display: "flex", alignItems: "center", padding: "0 12px", fontSize: 13, fontWeight: 600, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Chart area */}
          <div style={{ flex: 1, position: "relative" }}>
            {/* Header */}
            <div style={{ height: HEADER_HEIGHT, borderBottom: "1px solid var(--border)", position: "relative" }}>
              {/* Cycle bands */}
              <div style={{ height: CYCLE_ROW_HEIGHT, position: "relative", borderBottom: "1px solid var(--border)" }}>
                {schedule.cycles.map((cycle, i) => {
                  const cols = getBarCols(cycle.startDay, cycle.endDay);
                  if (!cols) return null;
                  const left = cols[0] * DAY_WIDTH;
                  const width = (cols[1] - cols[0]) * DAY_WIDTH;
                  return (
                    <div
                      key={`cycle-${i}`}
                      style={{
                        position: "absolute", left, width, top: 0, height: CYCLE_ROW_HEIGHT,
                        background: CYCLE_COLORS[i % CYCLE_COLORS.length],
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontWeight: 600, color: "var(--text)", overflow: "hidden", whiteSpace: "nowrap",
                        borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)",
                      }}
                    >
                      {width > 50 ? cycle.label : ""}
                    </div>
                  );
                })}
                {/* Cooldown bands (gaps between consecutive cycles) */}
                {schedule.cycles.map((cycle, i) => {
                  if (i >= schedule.cycles.length - 1) return null;
                  const nextCycle = schedule.cycles[i + 1];
                  if (nextCycle.startDay <= cycle.endDay) return null; // no gap
                  const cols = getBarCols(cycle.endDay, nextCycle.startDay);
                  if (!cols) return null;
                  const left = cols[0] * DAY_WIDTH;
                  const width = (cols[1] - cols[0]) * DAY_WIDTH;
                  return (
                    <div
                      key={`cooldown-${i}`}
                      style={{
                        position: "absolute", left, width, top: 0, height: CYCLE_ROW_HEIGHT,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 9, fontWeight: 500, color: "var(--text-muted)", overflow: "hidden", whiteSpace: "nowrap",
                        borderLeft: "2px solid var(--border)",
                      }}
                    >
                      {width > 40 ? "Cooldown" : ""}
                    </div>
                  );
                })}
              </div>
              {/* Date row */}
              <div style={{ height: DATE_ROW_HEIGHT, display: "flex" }}>
                {visibleDays.map((h) => {
                  const isPast = todayCol >= 0 && h.col < todayCol;
                  return (
                  <div
                    key={h.day}
                    style={{
                      width: DAY_WIDTH, minWidth: DAY_WIDTH,
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
                      paddingBottom: 6, fontSize: 10,
                      color: h.isGrayed || isPast ? "var(--text-muted)" : "var(--text)",
                      opacity: h.isGrayed ? 0.5 : isPast ? 0.6 : 1,
                      borderLeft: h.col === todayCol ? "2px solid #ef4444" : (h.isCycleStart || h.isCycleEnd) ? "2px solid var(--border)" : h.isMonday ? "1px solid var(--border)" : "none",
                      background: isPast ? "rgba(128,128,128,0.08)" : undefined,
                    }}
                  >
                    <span>{h.date.toLocaleDateString("en-US", { weekday: "short" })}</span>
                    <span style={{ fontWeight: 600 }}>{h.date.getDate()}</span>
                    <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{h.date.toLocaleDateString("en-US", { month: "short" })}</span>
                  </div>
                  );
                })}
              </div>
            </div>

            {/* Grid and bars */}
            <div style={{ position: "relative" }}>
              {/* Grayed columns */}
              {visibleDays.filter((h) => h.isGrayed).map((h) => (
                <div key={`g-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: DAY_WIDTH, height: chartContentHeight, background: "var(--weekend)", pointerEvents: "none" }} />
              ))}

              {/* Monday grid lines */}
              {visibleDays.filter((h) => h.isMonday).map((h) => (
                <div key={`gl-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: 1, height: chartContentHeight, background: "var(--border)", pointerEvents: "none" }} />
              ))}

              {/* Cycle boundary lines (gray, thick) */}
              {visibleDays.filter((h) => h.isCycleStart).map((h) => (
                <div key={`cs-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: 2, height: chartContentHeight, background: "var(--border)", pointerEvents: "none", zIndex: 2 }} />
              ))}
              {visibleDays.filter((h) => h.isCycleEnd).map((h) => (
                <div key={`ce-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: 2, height: chartContentHeight, background: "var(--border)", pointerEvents: "none", zIndex: 2 }} />
              ))}

              {/* Past overlay */}
              {todayCol > 0 && (
                <div style={{ position: "absolute", left: 0, top: 0, width: todayCol * DAY_WIDTH, height: chartContentHeight, background: "rgba(128,128,128,0.15)", pointerEvents: "none", zIndex: 1 }} />
              )}

              {/* Milestone groups */}
              {milestoneGroups.map((group) => (
                <div key={group.milestoneId ?? "none"}>
                  <div style={{ height: SEPARATOR_HEIGHT, borderTop: "2px solid var(--iteration-line)" }} />
                  {group.workerRows.map((row) => (
                    <div key={row.worker} style={{ position: "relative", height: ROW_HEIGHT + ROW_GAP, display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}>
                      {row.issues.map((issue) => {
                        const cols = getBarCols(issue.startDay, issue.endDay);
                        if (!cols) return null;
                        const [startCol, endCol] = cols;
                        const barWidth = Math.max((endCol - startCol) * DAY_WIDTH - 4, 4);
                        const isBlocked = issue.blockedBy.some((b) => !b.done);

                        // Non-working/outside-cycle day overlays within bar
                        const grayedCols: number[] = [];
                        for (let d = issue.startDay; d < issue.endDay && d < dayToCol.length; d++) {
                          const c = dayToCol[d];
                          if (c >= 0) {
                            const info = allDays[d];
                            if (info && info.isGrayed) grayedCols.push(c - startCol);
                          }
                        }

                        return (
                          <div
                            key={issue.id}
                            onMouseEnter={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setTooltipInfo({ issue, x: rect.left + rect.width / 2, y: rect.top });
                            }}
                            onMouseLeave={() => setTooltipInfo(null)}
                            onClick={() => window.open(issue.url, "_blank")}
                            style={{
                              position: "absolute",
                              left: startCol * DAY_WIDTH + 2,
                              width: barWidth,
                              height: ROW_HEIGHT - 4,
                              background: [
                                isBlocked ? BLOCKED_STRIPE : null,
                                !issue.hasEstimate ? NO_ESTIMATE_BG : "var(--surface-hover)",
                              ].filter(Boolean).join(", "),
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                              paddingLeft: 5,
                              paddingRight: 5,
                              fontSize: 11,
                              fontWeight: 500,
                              color: "var(--text)",
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                              cursor: "pointer",
                              opacity: issue.done ? 0.5 : 1,
                            }}
                          >
                            {grayedCols.map((relCol) => (
                              <div key={`g-${relCol}`} style={{ position: "absolute", left: relCol * DAY_WIDTH - 2, top: 0, width: DAY_WIDTH, height: "100%", background: "rgba(0,0,0,0.08)", pointerEvents: "none" }} />
                            ))}
                            <AssigneeAvatar url={issue.assigneeAvatarUrl} name={issue.assigneeName} size={16} />
                            <StatusCircle stateType={issue.stateType} color={issue.stateColor} progress={issue.stateProgress} />
                            {isBlocked && <BlockedIcon />}
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", position: "relative", zIndex: 1 }}>
                              {issue.identifier} {issue.title}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Tooltip */}
        {tooltipInfo && (
          <div
            style={{
              position: "fixed", left: tooltipInfo.x, top: tooltipInfo.y - 8,
              transform: "translate(-50%, -100%)",
              background: "var(--surface-hover)", border: "1px solid var(--border)",
              borderRadius: 6, padding: "8px 12px", fontSize: 12, zIndex: 100,
              pointerEvents: "none", maxWidth: 320,
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {tooltipInfo.issue.identifier}: {tooltipInfo.issue.title}
            </div>
            {tooltipInfo.issue.assigneeName && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-muted)", marginBottom: 2 }}>
                <AssigneeAvatar url={tooltipInfo.issue.assigneeAvatarUrl} name={tooltipInfo.issue.assigneeName} size={14} />
                <span>{tooltipInfo.issue.assigneeName}</span>
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
              {tooltipInfo.issue.priority > 0 && <PriorityIcon priority={tooltipInfo.issue.priority} size={14} />}
              {tooltipInfo.issue.priorityLabel !== "No priority" && <span>{tooltipInfo.issue.priorityLabel}</span>}
              {tooltipInfo.issue.priorityLabel !== "No priority" && <span>&middot;</span>}
              <span>
                {tooltipInfo.issue.duration} working day{tooltipInfo.issue.duration > 1 ? "s" : ""}
                {!tooltipInfo.issue.hasEstimate && " (no estimate)"} &middot; {tooltipInfo.issue.stateName}
              </span>
            </div>
            <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
              {formatDate(dayToDate(schedule.startDate, tooltipInfo.issue.startDay))} &rarr;{" "}
              {formatDate(dayToDate(schedule.startDate, tooltipInfo.issue.endDay - 1))}
            </div>
            {!tooltipInfo.issue.done && tooltipInfo.issue.blockedBy.filter((b) => !b.done).length > 0 && (
              <div style={{ color: "var(--text-muted)", marginTop: 4, fontSize: 11 }}>
                Blocked by:
                {tooltipInfo.issue.blockedBy.filter((b) => !b.done).map((b) => (
                  <div key={b.identifier} style={{ marginLeft: 8 }}>{b.identifier} {b.title}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
