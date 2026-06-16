// Calendar / working-day utilities — French holidays, weekends, working-day indexing,
// Paris-time half-day thresholds, and date formatting.

export const MS_PER_DAY = 1000 * 60 * 60 * 24;

// --- French public holidays ---

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function frenchHolidays(year: number): Set<string> {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (d: Date, n: number) => {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  };
  const easter = easterSunday(year);
  return new Set(
    [
      new Date(year, 0, 1), // New Year
      new Date(year, 4, 1), // Labour Day
      new Date(year, 4, 8), // Victory in Europe
      new Date(year, 6, 14), // Bastille Day
      new Date(year, 7, 15), // Assumption
      new Date(year, 10, 1), // All Saints
      new Date(year, 10, 11), // Armistice
      new Date(year, 11, 25), // Christmas
      addDays(easter, 1), // Easter Monday
      addDays(easter, 39), // Ascension Thursday
      addDays(easter, 50), // Whit Monday
    ].map(fmt),
  );
}

const holidayCache = new Map<number, Set<string>>();
function isHolidayDate(date: Date): boolean {
  const year = date.getFullYear();
  if (!holidayCache.has(year)) holidayCache.set(year, frenchHolidays(year));
  const key = `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return holidayCache.get(year)!.has(key);
}

/** Exported for use by the chart to gray out non-working day columns */
export function isNonWorkingDay(date: Date): boolean {
  const dow = date.getDay();
  return dow === 0 || dow === 6 || isHolidayDate(date);
}

/** Check if a date is a bank holiday (weekday holiday, not a weekend) */
export function isBankHoliday(date: Date): boolean {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6 && isHolidayDate(date);
}

// --- Working day calendar ---

export function buildWorkingDayCalendar(startDate: Date, maxCalendarDays: number) {
  const workingDays: number[] = [];
  const calendarToWd: number[] = [];

  for (let d = 0; d < maxCalendarDays; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    if (!isNonWorkingDay(date)) {
      calendarToWd.push(workingDays.length);
      workingDays.push(d);
    } else {
      calendarToWd.push(-1);
    }
  }

  return {
    toCalendar(wdIndex: number): number {
      if (wdIndex < workingDays.length) return workingDays[wdIndex];
      let d = workingDays.length > 0 ? workingDays[workingDays.length - 1] + 1 : 0;
      let idx = workingDays.length;
      while (idx <= wdIndex) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + d);
        if (!isNonWorkingDay(date)) {
          if (idx === wdIndex) return d;
          idx++;
        }
        d++;
      }
      return d;
    },
    /** Convert calendar day offset to working day index (next wd if non-working) */
    toWorkingDay(calendarDay: number): number {
      if (calendarDay >= 0 && calendarDay < calendarToWd.length) {
        const wd = calendarToWd[calendarDay];
        if (wd >= 0) return wd;
      }
      let d = Math.max(calendarDay, 0);
      while (d < calendarToWd.length) {
        if (calendarToWd[d] >= 0) return calendarToWd[d];
        d++;
      }
      return workingDays.length;
    },
    workingDays,
    calendarToWd,
  };
}

export function dateToCalendarOffset(date: Date, startDate: Date): number {
  return Math.round((date.getTime() - startDate.getTime()) / MS_PER_DAY);
}

// --- Paris time / half-day adjustment ---

export function getParisHourMinute(isoString: string): { hour: number; minute: number } {
  const d = new Date(isoString);
  const hour = parseInt(d.toLocaleString("en-US", { timeZone: "Europe/Paris", hour: "numeric", hour12: false }), 10);
  const minute = parseInt(d.toLocaleString("en-US", { timeZone: "Europe/Paris", minute: "numeric" }), 10);
  return { hour, minute };
}

export function isAfterThreshold(isoString: string): boolean {
  const { hour, minute } = getParisHourMinute(isoString);
  return hour > 13 || (hour === 13 && minute >= 30);
}

export function halfDayAdjustment(startedAt: string | null, endedAt: string | null): number {
  let adj = 0;
  if (startedAt && isAfterThreshold(startedAt)) adj -= 0.5;
  if (endedAt && !isAfterThreshold(endedAt)) adj -= 0.5;
  return adj;
}

/** A short "morning"/"afternoon" label derived from Paris time of day */
export function formatParisTimeOfDay(isoString: string): string {
  const { hour } = getParisHourMinute(isoString);
  return hour < 13 ? "morning" : "afternoon";
}

// --- Date formatting ---

/** Convert a day offset to a Date */
export function dayToDate(startDate: Date, dayOffset: number): Date {
  const d = new Date(startDate);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

/** Format a date as "Mon DD" */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
