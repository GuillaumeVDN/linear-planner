import { describe, it, expect } from "vitest";
import { isNonWorkingDay, getParisHourMinute, halfDayAdjustment } from "./workingDays";

const MONDAY = new Date(2025, 3, 7); // April 7, 2025

describe("isNonWorkingDay", () => {
  it("weekends are non-working days", () => {
    const saturday = new Date(2025, 3, 12); // Apr 12, 2025 = Saturday
    const sunday = new Date(2025, 3, 13);   // Apr 13, 2025 = Sunday
    expect(isNonWorkingDay(saturday)).toBe(true);
    expect(isNonWorkingDay(sunday)).toBe(true);
  });

  it("weekdays are working days (when not holidays)", () => {
    expect(isNonWorkingDay(MONDAY)).toBe(false); // Apr 7, 2025 = Monday
  });

  it("French holidays are non-working days", () => {
    const labourDay = new Date(2025, 4, 1); // May 1
    expect(isNonWorkingDay(labourDay)).toBe(true);
  });
});

describe("half-day adjustment", () => {
  describe("getParisHourMinute", () => {
    it("returns Paris hour and minute for a UTC timestamp", () => {
      // 2025-04-07T12:00:00Z = 14:00 Paris (CEST, UTC+2)
      expect(getParisHourMinute("2025-04-07T12:00:00.000Z")).toEqual({ hour: 14, minute: 0 });
    });

    it("returns Paris hour and minute for morning UTC", () => {
      // 2025-04-07T08:30:00Z = 10:30 Paris
      expect(getParisHourMinute("2025-04-07T08:30:00.000Z")).toEqual({ hour: 10, minute: 30 });
    });

    it("handles winter time (CET, UTC+1)", () => {
      // 2025-01-15T12:00:00Z = 13:00 Paris (CET)
      expect(getParisHourMinute("2025-01-15T12:00:00.000Z")).toEqual({ hour: 13, minute: 0 });
    });
  });

  describe("halfDayAdjustment", () => {
    it("returns 0 when started before 13:30 and ended after 13:30", () => {
      expect(halfDayAdjustment("2025-04-07T08:00:00.000Z", "2025-04-10T12:00:00.000Z")).toBe(0);
    });

    it("returns -0.5 when started at or after 13:30 Paris", () => {
      // 11:30 UTC = 13:30 Paris (CEST)
      expect(halfDayAdjustment("2025-04-07T11:30:00.000Z", "2025-04-10T12:00:00.000Z")).toBe(-0.5);
    });

    it("returns 0 when started just before 13:30 Paris", () => {
      // 11:29 UTC = 13:29 Paris (CEST)
      expect(halfDayAdjustment("2025-04-07T11:29:00.000Z", "2025-04-10T12:00:00.000Z")).toBe(0);
    });

    it("returns -0.5 when ended before 13:30 Paris", () => {
      // 10:00 UTC = 12:00 Paris (CEST)
      expect(halfDayAdjustment("2025-04-07T08:00:00.000Z", "2025-04-10T10:00:00.000Z")).toBe(-0.5);
    });

    it("returns 0 when ended at 13:30 Paris", () => {
      // 11:30 UTC = 13:30 Paris (CEST)
      expect(halfDayAdjustment("2025-04-07T08:00:00.000Z", "2025-04-10T11:30:00.000Z")).toBe(0);
    });

    it("returns -1 when both started late and ended early", () => {
      expect(halfDayAdjustment("2025-04-07T11:30:00.000Z", "2025-04-10T10:00:00.000Z")).toBe(-1);
    });

    it("returns 0 when both are null", () => {
      expect(halfDayAdjustment(null, null)).toBe(0);
    });

    it("applies only start adjustment when end is null (in-progress)", () => {
      expect(halfDayAdjustment("2025-04-07T11:30:00.000Z", null)).toBe(-0.5);
      expect(halfDayAdjustment("2025-04-07T08:00:00.000Z", null)).toBe(0);
    });
  });
});
