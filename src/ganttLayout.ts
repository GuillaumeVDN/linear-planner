import type { CyclePeriod } from "./scheduler";

export const ROW_HEIGHT = 36;
export const ROW_GAP = 4;
export const CYCLE_ROW_HEIGHT = 22;
export const DATE_ROW_HEIGHT = 50;
export const HEADER_HEIGHT = CYCLE_ROW_HEIGHT + DATE_ROW_HEIGHT;
export const DAY_WIDTH = 40;
export const LABEL_WIDTH = 220;

export interface DayInfo {
  day: number; // calendar day offset
  col: number; // visual column index
  date: Date;
  isGrayed: boolean; // non-working or outside cycle
  isMonday: boolean;
  isCycleEnd: boolean;
  isCycleStart: boolean;
}

export function isOutsideCycles(day: number, cycles: CyclePeriod[]): boolean {
  if (cycles.length === 0) return false;
  return !cycles.some((c) => day >= c.startDay && day < c.endDay);
}
