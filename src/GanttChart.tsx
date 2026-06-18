import { useMemo, useRef, useEffect, useState } from "react";
import type { ScheduleResult, ScheduledIssue } from "./scheduler";
import { dayToDate, formatDate, isBankHoliday, formatParisTimeOfDay, isAfterThreshold } from "./workingDays";
import { StatusCircle } from "./StatusCircle";
import { BlockedIcon, PriorityIcon, AssigneeAvatar, DurationBadge } from "./CardIcons";
import { MilestoneHeader, buildMilestoneSummary, type MilestoneSummaryData } from "./MilestoneHeader";
import { Legend } from "./Legend";
import { BLOCKED_STRIPE, NO_ESTIMATE_BG, DONE_STRIPE, ongoingStatusBg, isBlockedDisplay } from "./cardStyle";
import {
  ROW_HEIGHT, ROW_GAP, CYCLE_ROW_HEIGHT, DATE_ROW_HEIGHT, HEADER_HEIGHT,
  DAY_WIDTH, LABEL_WIDTH,
  type DayInfo, isOutsideCycles,
} from "./ganttLayout";

interface MilestoneGroup {
  milestoneId: string | null;
  milestoneName: string;
  workerRows: Array<{ worker: number; issues: ScheduledIssue[] }>;
  summary: MilestoneSummaryData;
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
  const [msHeaderHeights, setMsHeaderHeights] = useState<Record<string, number>>({});
  const msHeaderRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const numWorkers = useMemo(() => Math.max(...schedule.issues.map((i) => i.worker), -1) + 1, [schedule]);

  // Compute the set of day ranges (cycles & cooldowns) that contain no scheduled issues,
  // so we can hide their columns entirely.
  const emptyRanges = useMemo(() => {
    const ranges: Array<[number, number]> = [];
    for (const cycle of schedule.cycles) {
      if (!schedule.issues.some((i) => i.startDay < cycle.endDay && i.endDay > cycle.startDay)) {
        ranges.push([cycle.startDay, cycle.endDay]);
      }
    }
    if (!showCooldown) {
      for (let i = 0; i < schedule.cycles.length - 1; i++) {
        const gapStart = schedule.cycles[i].endDay;
        const gapEnd = schedule.cycles[i + 1].startDay;
        if (gapEnd <= gapStart) continue;
        if (!schedule.issues.some((si) => si.startDay < gapEnd && si.endDay > gapStart)) {
          ranges.push([gapStart, gapEnd]);
        }
      }
    }
    return ranges;
  }, [schedule.cycles, schedule.issues, showCooldown]);

  function isInEmptyRange(day: number): boolean {
    return emptyRanges.some(([start, end]) => day >= start && day < end);
  }

  const milestoneGroups = useMemo(() => {
    const groups: MilestoneGroup[] = [];

    function buildWorkerRows(msIssues: ScheduledIssue[]) {
      const workerRows: MilestoneGroup["workerRows"] = [];
      for (let w = 0; w < numWorkers; w++) {
        const issues = msIssues.filter((i) => i.worker === w).sort((a, b) => a.startDay - b.startDay);
        if (issues.length > 0) workerRows.push({ worker: w, issues });
      }
      return workerRows;
    }

    for (const ms of schedule.milestones) {
      const msIssues = schedule.issues.filter((i) => i.milestone?.id === ms.id);
      if (msIssues.length === 0) continue;
      groups.push({ milestoneId: ms.id, milestoneName: ms.name, workerRows: buildWorkerRows(msIssues), summary: buildMilestoneSummary(msIssues, schedule.startDate, schedule.configuredWorkers, schedule.cycles) });
    }

    const noMsIssues = schedule.issues.filter((i) => !i.milestone);
    if (noMsIssues.length > 0) {
      groups.push({ milestoneId: null, milestoneName: "No milestone", workerRows: buildWorkerRows(noMsIssues), summary: buildMilestoneSummary(noMsIssues, schedule.startDate, schedule.configuredWorkers, schedule.cycles) });
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
      if (isInEmptyRange(d.day)) continue;
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
  }, [allDays, showWeekends, showHolidays, showCooldown, emptyRanges]);

  // Map calendar day offset → visual column (or -1 if hidden)
  const dayToCol = useMemo(() => {
    const map = new Array(totalCalendarDays).fill(-1);
    for (const v of visibleDays) map[v.day] = v.col;
    return map;
  }, [visibleDays, totalCalendarDays]);

  // Bar column helpers — handle integer day spans (cycles, cooldowns).
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

  /**
   * Half-day-aware geometry for issue bars. `startDay`/`endDay` are decimal calendar offsets
   * (.0 = AM, .5 = PM). Returns the absolute left/width in pixels for the bar, accounting
   * for hidden columns (weekends/holidays/cooldown) and AM/PM trimming on boundary days.
   */
  function getBarBounds(startDay: number, endDay: number): { left: number; width: number; firstVisCol: number; lastVisCol: number } | null {
    const startInt = Math.floor(startDay);
    const startFrac = startDay - startInt; // 0 or 0.5
    const endHasFrac = endDay - Math.floor(endDay) > 0;
    const lastIntDay = endHasFrac ? Math.floor(endDay) : endDay - 1;
    const endTrailingFrac = endHasFrac ? 0.5 : 1.0;
    if (lastIntDay < startInt) return null;

    let firstVisCol = -1;
    let lastVisCol = -1;
    let firstVisDay = -1;
    let lastVisDay = -1;
    const end = Math.min(lastIntDay, dayToCol.length - 1);
    for (let d = startInt; d <= end; d++) {
      const c = dayToCol[d];
      if (c >= 0) {
        if (firstVisCol < 0) { firstVisCol = c; firstVisDay = d; }
        lastVisCol = c;
        lastVisDay = d;
      }
    }
    if (firstVisCol < 0) return null;

    const leftFrac = firstVisDay === startInt ? startFrac : 0;
    const left = (firstVisCol + leftFrac) * DAY_WIDTH;
    const rightFrac = lastVisDay === lastIntDay ? endTrailingFrac : 1.0;
    const right = (lastVisCol + rightFrac) * DAY_WIDTH;

    return { left, width: right - left, firstVisCol, lastVisCol };
  }

  const totalVisibleCols = visibleDays.length;
  const chartWidth = totalVisibleCols * DAY_WIDTH;


  // First column past the latest scheduled issue's end — used to gray "no-more-work" future days.
  const futureStartCol = useMemo(() => {
    const lastIssueEnd = Math.max(...schedule.issues.map((i) => i.endDay), 0);
    // Round up to the next integer day for the lookup (endDay can be fractional now).
    for (let d = Math.ceil(lastIssueEnd); d < dayToCol.length; d++) {
      if (dayToCol[d] >= 0) return dayToCol[d];
    }
    return -1;
  }, [schedule.issues, dayToCol]);

  const todayCol = useMemo(() => {
    const to = schedule.todayOffset;
    if (to >= 0 && to < dayToCol.length) {
      if (dayToCol[to] >= 0) return dayToCol[to];
      // Today is hidden (weekend/holiday) — find the next visible column
      for (let d = to + 1; d < dayToCol.length; d++) {
        if (dayToCol[d] >= 0) return dayToCol[d];
      }
    }
    return -1;
  }, [schedule.todayOffset, dayToCol]);

  const todayIsPm = useMemo(() => isAfterThreshold(new Date().toISOString()), []);

  useEffect(() => {
    if (!containerRef.current) return;
    // Anchor: start of the oldest currently-ongoing issue. Fall back to today.
    const ongoing = schedule.issues.filter((i) => i.stateType === "started" && !i.done);
    let anchorCol = -1;
    if (ongoing.length > 0) {
      // Floor for the column lookup since startDay can now be fractional (.5 = PM).
      const oldestStart = Math.floor(Math.min(...ongoing.map((i) => i.startDay)));
      if (oldestStart >= 0 && oldestStart < dayToCol.length && dayToCol[oldestStart] >= 0) {
        anchorCol = dayToCol[oldestStart];
      }
    }
    if (anchorCol < 0) anchorCol = todayCol;
    if (anchorCol >= 0) {
      containerRef.current.scrollLeft = Math.max(0, anchorCol * DAY_WIDTH);
    }
  }, [schedule.issues, todayCol, dayToCol]);

  useEffect(() => {
    const heights: Record<string, number> = {};
    for (const [key, el] of Object.entries(msHeaderRefs.current)) {
      if (el) heights[key] = el.offsetHeight;
    }
    setMsHeaderHeights(heights);
  }, [milestoneGroups]);

  return (
    <div>
      <Legend issues={schedule.issues} showOptions={{ showWeekends, setShowWeekends, showHolidays, setShowHolidays, showCooldown, setShowCooldown }} />
      {/* Scrollable chart */}
      <div
        ref={containerRef}
        style={{
          overflow: "auto",
          background: "var(--surface)",
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
            {milestoneGroups.map((group) => {
              const mid = group.milestoneId ?? "none";
              const labelH = msHeaderHeights[mid] ?? 0;
              const rowsH = group.workerRows.length * (ROW_HEIGHT + ROW_GAP);
              const milestoneH = Math.max(labelH, rowsH);
              // Label at the top, no per-row empty divs — the right side packs its rows from
              // the top of the same milestone block, so vertical alignment comes from this
              // outer height matching on both sides.
              return (
                <div key={mid} style={{ height: milestoneH }}>
                  <div
                    ref={(el) => { msHeaderRefs.current[mid] = el; }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-start",
                      padding: "10px 12px",
                      borderTop: "2px solid var(--iteration-line)",
                      background: "var(--surface)",
                      overflow: "hidden",
                      gap: 1,
                    }}
                  >
                    <MilestoneHeader name={group.milestoneName} summary={group.summary} />
                  </div>
                </div>
              );
            })}
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
                  let workingDayCount = 0;
                  for (let d = cycle.startDay; d < cycle.endDay && d < allDays.length; d++) {
                    const info = allDays[d];
                    if (info && !info.isWeekend && !info.isHoliday) workingDayCount++;
                  }
                  return (
                    <div
                      key={`cycle-${i}`}
                      style={{
                        position: "absolute", left, width, top: 0, height: CYCLE_ROW_HEIGHT,
                        background: "rgba(59, 130, 246, 0.18)",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                        fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", whiteSpace: "nowrap",
                        borderLeft: cols[0] > 0 ? "1px solid #333" : "none",
                      }}
                    >
                      {width > 50 && (
                        <>
                          <span>{cycle.label}</span>
                          <span style={{ fontStyle: "italic", fontWeight: 400, color: "var(--text-muted)" }}>
                            ({workingDayCount} working day{workingDayCount !== 1 ? "s" : ""})
                          </span>
                        </>
                      )}
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
                        borderLeft: "1px solid #333",
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
                  const isFutureEmpty = futureStartCol >= 0 && h.col >= futureStartCol;
                  return (
                  <div
                    key={h.day}
                    style={{
                      width: DAY_WIDTH, minWidth: DAY_WIDTH,
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
                      paddingBottom: 6, fontSize: 11,
                      color: h.isGrayed || isPast ? "var(--text-muted)" : "var(--text)",
                      opacity: h.isGrayed ? 0.5 : isPast ? 0.6 : 1,
                      borderLeft: (h.col > 0 && (h.isCycleStart || h.isCycleEnd)) ? "1px solid #333" : h.isMonday ? "1px solid var(--border)" : "none",
                      background: h.col === todayCol ? "rgba(96, 165, 250, 0.12)" : (isPast || isFutureEmpty) ? "rgba(128,128,128,0.08)" : undefined,
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
                <div key={`g-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: DAY_WIDTH, height: "100%", background: "var(--weekend)", pointerEvents: "none" }} />
              ))}

              {/* Faint grid lines: every day boundary + each day's mid-point (AM/PM split). */}
              {visibleDays.map((h) => (
                <div key={`day-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: 1, height: "100%", background: "rgba(128,128,128,0.06)", pointerEvents: "none" }} />
              ))}
              {visibleDays.map((h) => (
                <div key={`half-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH + DAY_WIDTH / 2, top: 0, width: 1, height: "100%", background: "rgba(128,128,128,0.03)", pointerEvents: "none" }} />
              ))}

              {/* Monday grid lines (stronger, on top of the faint daily lines) */}
              {visibleDays.filter((h) => h.isMonday).map((h) => (
                <div key={`gl-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: 1, height: "100%", background: "var(--border)", pointerEvents: "none" }} />
              ))}

              {/* Cycle boundary lines (one per boundary col — a day that's both cycle-start AND cycle-end gets a single line). */}
              {visibleDays.filter((h) => (h.isCycleStart && h.col > 0) || h.isCycleEnd).map((h) => (
                <div key={`cb-${h.col}`} style={{ position: "absolute", left: h.col * DAY_WIDTH, top: 0, width: 1, height: "100%", background: "#333", pointerEvents: "none", zIndex: 2 }} />
              ))}

              {/* Past overlay */}
              {todayCol > 0 && (
                <div style={{ position: "absolute", left: 0, top: 0, width: todayCol * DAY_WIDTH, height: "100%", background: "rgba(128,128,128,0.15)", pointerEvents: "none", zIndex: 1 }} />
              )}
              {/* Empty-future overlay (days past the latest scheduled issue) */}
              {futureStartCol >= 0 && futureStartCol < visibleDays.length && (
                <div style={{ position: "absolute", left: futureStartCol * DAY_WIDTH, top: 0, width: (visibleDays.length - futureStartCol) * DAY_WIDTH, height: "100%", background: "rgba(128,128,128,0.15)", pointerEvents: "none", zIndex: 1 }} />
              )}
              {/* Today's still-current half — very light yellow (AM all day, PM only after the threshold). */}
              {todayCol >= 0 && (
                <div style={{ position: "absolute", left: todayCol * DAY_WIDTH + (todayIsPm ? DAY_WIDTH / 2 : 0), top: 0, width: todayIsPm ? DAY_WIDTH / 2 : DAY_WIDTH, height: "100%", background: "rgba(96, 165, 250, 0.12)", pointerEvents: "none", zIndex: 1 }} />
              )}
              {/* When it's already afternoon, treat today's AM half like past time (no yellow there). */}
              {todayCol >= 0 && todayIsPm && (
                <div style={{ position: "absolute", left: todayCol * DAY_WIDTH, top: 0, width: DAY_WIDTH / 2, height: "100%", background: "rgba(128,128,128,0.15)", pointerEvents: "none", zIndex: 1 }} />
              )}

              {/* Milestone groups */}
              {milestoneGroups.map((group) => {
                const mid = group.milestoneId ?? "none";
                const labelH = msHeaderHeights[mid] ?? 0;
                const rowsH = group.workerRows.length * (ROW_HEIGHT + ROW_GAP);
                const milestoneH = Math.max(labelH, rowsH);
                return (
                <div key={mid} style={{ height: milestoneH, position: "relative", zIndex: 3, borderTop: "2px solid var(--iteration-line)" }}>
                  {group.workerRows.map((row) => (
                    <div key={row.worker} style={{ position: "relative", zIndex: 2, height: ROW_HEIGHT + ROW_GAP, display: "flex", alignItems: "center" }}>
                      {row.issues.map((issue) => {
                        const bounds = getBarBounds(issue.startDay, issue.endDay);
                        if (!bounds) return null;
                        const { left: barLeft, width: barWidthRaw, firstVisCol } = bounds;
                        const barWidth = Math.max(barWidthRaw - 4, 4);
                        const isBlocked = isBlockedDisplay(issue);

                        // Non-working/outside-cycle day overlays within bar. We iterate by
                        // integer day to find grayed cells, positioning each overlay relative
                        // to the bar's first visible column.
                        const grayedCols: number[] = [];
                        const iterEnd = Math.min(Math.ceil(issue.endDay), dayToCol.length);
                        for (let d = Math.floor(issue.startDay); d < iterEnd; d++) {
                          const c = dayToCol[d];
                          if (c >= 0) {
                            const info = allDays[d];
                            if (info && info.isGrayed) grayedCols.push(c - firstVisCol);
                          }
                        }

                        // "Ignored" stretches (below-start / unassigned / no-count) painted over
                        // the in-progress bar in the pending color so they read as "not worked".
                        const ignoredBars = issue.ignoredRanges
                          .map((r) => getBarBounds(r.startDay, r.endDay))
                          .filter((b): b is NonNullable<typeof b> => b !== null)
                          .map((b) => ({ left: b.left - barLeft - 2, width: b.width }));

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
                              left: barLeft + 2,
                              width: barWidth,
                              height: ROW_HEIGHT - 4,
                              background: [
                                isBlocked ? BLOCKED_STRIPE : null,
                                issue.done ? DONE_STRIPE : null,
                                ongoingStatusBg(issue.stateType, issue.done, issue.stateColor) ?? (!issue.hasEstimate ? NO_ESTIMATE_BG : "var(--surface-hover)"),
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
                              zIndex: 2,
                            }}
                          >
                            {!issue.done && ignoredBars.map((b, idx) => (
                              <div key={`ig-${idx}`} style={{ position: "absolute", left: b.left, top: 0, width: b.width, height: "100%", background: "var(--surface-hover)", pointerEvents: "none" }} />
                            ))}
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
                );
              })}
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
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              {tooltipInfo.issue.identifier}: {tooltipInfo.issue.title}
            </div>
            {tooltipInfo.issue.labels.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                {tooltipInfo.issue.labels.map((l) => (
                  <span key={l.name} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, padding: "1px 6px", borderRadius: 3, background: `${l.color}20`, color: l.color, fontWeight: 500 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: l.color, flexShrink: 0 }} />
                    {l.name}
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
              {tooltipInfo.issue.assigneeName && <><AssigneeAvatar url={tooltipInfo.issue.assigneeAvatarUrl} name={tooltipInfo.issue.assigneeName} size={14} /><span>{tooltipInfo.issue.assigneeName}</span></>}
              {tooltipInfo.issue.assigneeName && tooltipInfo.issue.priority > 0 && <span>&middot;</span>}
              {tooltipInfo.issue.priority > 0 && <><PriorityIcon priority={tooltipInfo.issue.priority} size={14} /><span>{tooltipInfo.issue.priorityLabel}</span></>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              <StatusCircle stateType={tooltipInfo.issue.stateType} color={tooltipInfo.issue.stateColor} progress={tooltipInfo.issue.stateProgress} size={12} />
              <span>{tooltipInfo.issue.stateName}</span>
              <span>&middot;</span>
              <DurationBadge issue={tooltipInfo.issue} alwaysShowComparison />
            </div>
            {tooltipInfo.issue.belowStartBreakdown.length > 0 && (
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
                {tooltipInfo.issue.belowStartBreakdown.map((b) => (
                  <div key={b.stateName}>
                    {b.stateName}: {b.days % 1 === 0 ? b.days : b.days.toFixed(1)} working day{b.days === 1 ? "" : "s"}
                  </div>
                ))}
              </div>
            )}
            {tooltipInfo.issue.noCountDays > 0 && (
              <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2 }}>
                Excluded: {tooltipInfo.issue.noCountDays % 1 === 0 ? tooltipInfo.issue.noCountDays : tooltipInfo.issue.noCountDays.toFixed(1)} working day{tooltipInfo.issue.noCountDays === 1 ? "" : "s"}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              <span>{tooltipInfo.issue.daysSpent === null ? "~" : ""}{formatDate(dayToDate(schedule.startDate, Math.floor(tooltipInfo.issue.startDay)))}{tooltipInfo.issue.startedAtRaw ? `, ${formatParisTimeOfDay(tooltipInfo.issue.startedAtRaw)}` : ""}</span><span style={{ position: "relative", top: -2 }}>→</span><span>{!tooltipInfo.issue.done ? "~" : ""}{formatDate(dayToDate(schedule.startDate, Math.ceil(tooltipInfo.issue.endDay) - 1))}{tooltipInfo.issue.endedAtRaw ? `, ${formatParisTimeOfDay(tooltipInfo.issue.endedAtRaw)}` : ""}</span>
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
