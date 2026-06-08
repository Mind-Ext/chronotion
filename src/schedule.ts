/**
 * Schedule and date math for next_in interval/macro resolution.
 *
 * Supported formats:
 *   Intervals: "N d/day/days", "N w/week/weeks", "N m/month/months", "N y/yr/year/years"
 *   Macros: "first/second/3rd/../last day/monday/.. of month/january/.."
 *   Special: "never" (one-off, no rescheduling)
 */

import { stripTzBracket } from "./notion_utils.ts";

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const SHORT_DAY_NAMES = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const ORDINAL_MAP: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
  last: -1,
};

type ScheduleResult =
  | { ok: true; next: Temporal.ZonedDateTime }
  | { ok: false; error: string };

function toZonedDateTime(anchor: Date | string): Temporal.ZonedDateTime {
  if (typeof anchor === "string") {
    let str = anchor.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      str += "T00:00:00Z";
    }
    const tzMatch = str.match(/\[([^\]]+)\]$/);
    const offsetMatch = str.match(/([+-]\d{2}:\d{2})$/);
    // Note: offset-only strings (no IANA zone) use a fixed offset, so DST
    // transitions won't be handled — this is acceptable since the source
    // already lacked timezone identity.
    const tz = tzMatch ? tzMatch[1] : (offsetMatch ? offsetMatch[1] : "UTC");
    const cleanStr = stripTzBracket(str);
    const instant = Temporal.Instant.from(cleanStr);
    return instant.toZonedDateTimeISO(tz);
  } else {
    const instant = Temporal.Instant.fromEpochMilliseconds(anchor.getTime());
    return instant.toZonedDateTimeISO("UTC");
  }
}

/** Compute next scheduled_at from the given anchor date and next_in expression */
export function computeNextRun(
  anchor: Date | string,
  nextIn: string,
): ScheduleResult {
  const expr = nextIn.trim().toLowerCase();

  if (expr === "never" || expr === "") {
    return { ok: false, error: "never" };
  }

  // Convert anchor to ZonedDateTime
  const zdt = toZonedDateTime(anchor);

  // Try interval format: "N unit"
  const intervalResult = parseInterval(expr, zdt);
  if (intervalResult) return intervalResult;

  // Try macro format: "ordinal weekday/day of period"
  const macroResult = parseMacro(expr, zdt);
  if (macroResult) return macroResult;

  // Try weekday list format: "mon,wed,fri"
  const weekdayList = parseWeekdayList(expr);
  if (weekdayList && weekdayList.length > 0) {
    const next = computeNextWeekday(zdt, weekdayList);
    return { ok: true, next };
  }

  return { ok: false, error: `Invalid next_in expression: "${nextIn}"` };
}

/** Validate a next_in expression without computing a date */
export function validateNextIn(nextIn: string): string | null {
  const expr = nextIn.trim().toLowerCase();
  if (expr === "never" || expr === "") return null;

  // Check interval
  const intervalMatch = expr.match(
    /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|yr|year|years)$/,
  );
  if (intervalMatch) {
    if (parseInt(intervalMatch[1], 10) === 0) {
      return `Interval count must be greater than zero: "${nextIn}"`;
    }
    return null;
  }

  // Check macro
  const macroMatch = expr.match(
    /^(first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th))\s+(\w+)\s+of\s+(\w+)$/,
  );
  if (macroMatch) {
    const [, ordStr, targetStr, periodStr] = macroMatch;
    if (!(ordStr in ORDINAL_MAP) && !ordStr.match(/^\d+/)) {
      return `Invalid ordinal: "${ordStr}"`;
    }
    if (
      targetStr !== "day" &&
      !DAY_NAMES.includes(targetStr as typeof DAY_NAMES[number])
    ) {
      return `Invalid day name: "${targetStr}"`;
    }
    if (
      periodStr !== "month" &&
      !MONTH_NAMES.includes(periodStr as typeof MONTH_NAMES[number])
    ) {
      return `Invalid period: "${periodStr}"`;
    }
    return null;
  }

  // Check weekday list
  if (parseWeekdayList(expr) !== null) {
    return null;
  }

  return `Invalid next_in expression: "${nextIn}"`;
}

/** Check if a date matches a macro expression (for first-instance validation) */
export function dateMatchesMacro(date: Date, nextIn: string): boolean {
  const result = parseMacroSpec(nextIn.trim().toLowerCase());
  if (!result) return true; // Not a macro, no validation needed

  const { ordinal, target, period } = result;
  const zdt = toZonedDateTime(date);
  return dateMatchesSpec(zdt, ordinal, target, period);
}

function parseInterval(
  expr: string,
  anchor: Temporal.ZonedDateTime,
): ScheduleResult | null {
  const match = expr.match(
    /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|yr|year|years)$/,
  );
  if (!match) return null;

  const count = parseInt(match[1], 10);
  if (count === 0) {
    return {
      ok: false,
      error: `Interval count must be greater than zero: "${expr}"`,
    };
  }
  const unit = match[2];

  let next: Temporal.ZonedDateTime;
  if (unit.startsWith("d")) {
    next = anchor.add({ days: count });
  } else if (unit.startsWith("w")) {
    next = anchor.add({ weeks: count });
  } else if (unit.startsWith("m")) {
    next = anchor.add({ months: count });
  } else if (unit.startsWith("y")) {
    next = anchor.add({ years: count });
  } else {
    return null;
  }

  return { ok: true, next };
}

interface MacroSpec {
  ordinal: number;
  target: string;
  period: string;
}

function parseMacroSpec(expr: string): MacroSpec | null {
  const match = expr.match(
    /^(first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th))\s+(\w+)\s+of\s+(\w+)$/,
  );
  if (!match) return null;

  const [, ordStr, target, period] = match;

  let ordinal: number;
  if (ordStr in ORDINAL_MAP) {
    ordinal = ORDINAL_MAP[ordStr];
  } else {
    ordinal = parseInt(ordStr);
  }

  if (
    target !== "day" &&
    !DAY_NAMES.includes(target as typeof DAY_NAMES[number])
  ) {
    return null;
  }
  if (
    period !== "month" &&
    !MONTH_NAMES.includes(period as typeof MONTH_NAMES[number])
  ) {
    return null;
  }

  return { ordinal, target, period };
}

function parseMacro(
  expr: string,
  anchor: Temporal.ZonedDateTime,
): ScheduleResult | null {
  const spec = parseMacroSpec(expr);
  if (!spec) return null;

  const { ordinal, target, period } = spec;

  // Determine the next occurrence AFTER the anchor
  let searchZdt = anchor;

  for (let i = 0; i < 24; i++) {
    // Search up to 2 years ahead
    if (period === "month") {
      // Move to next month
      if (i > 0) {
        searchZdt = searchZdt.add({ months: 1 });
      }
    } else {
      // Specific month — find the next occurrence of that month
      const targetMonth = MONTH_NAMES.indexOf(
        period as typeof MONTH_NAMES[number],
      ) + 1; // 1-indexed in Temporal
      if (i === 0) {
        // Start from current year's target month, or next year if passed
        searchZdt = Temporal.ZonedDateTime.from({
          year: anchor.year,
          month: targetMonth,
          day: 1,
          hour: anchor.hour,
          minute: anchor.minute,
          second: anchor.second,
          millisecond: anchor.millisecond,
          microsecond: anchor.microsecond,
          nanosecond: anchor.nanosecond,
          timeZone: anchor.timeZoneId,
        });
        if (Temporal.Instant.compare(searchZdt.toInstant(), anchor.toInstant()) <= 0) {
          searchZdt = searchZdt.add({ years: 1 });
        }
      } else {
        searchZdt = searchZdt.add({ years: 1 });
      }
    }

    const resultZdt = findOrdinalInMonth(
      searchZdt,
      ordinal,
      target,
    );

    if (resultZdt && Temporal.Instant.compare(resultZdt.toInstant(), anchor.toInstant()) > 0) {
      return { ok: true, next: resultZdt };
    }
  }

  return { ok: false, error: `Could not find next occurrence for "${expr}"` };
}

function findOrdinalInMonth(
  searchZdt: Temporal.ZonedDateTime,
  ordinal: number,
  target: string,
): Temporal.ZonedDateTime | null {
  if (target === "day") {
    // Nth day of the month
    const daysInMonth = searchZdt.daysInMonth;
    if (ordinal === -1) {
      // Last day
      return searchZdt.with({ day: daysInMonth });
    }
    if (ordinal > daysInMonth) return null;
    return searchZdt.with({ day: ordinal });
  }

  // Nth weekday of the month
  const targetDay = DAY_NAMES.indexOf(target as typeof DAY_NAMES[number]);
  if (targetDay === -1) return null;

  if (ordinal === -1) {
    // Last occurrence: start from end of month, walk backward
    const daysInMonth = searchZdt.daysInMonth;
    for (let d = daysInMonth; d >= 1; d--) {
      const zdt = searchZdt.with({ day: d });
      if (zdt.dayOfWeek % 7 === targetDay) return zdt;
    }
    return null;
  }

  // Find the Nth occurrence
  let count = 0;
  const daysInMonth = searchZdt.daysInMonth;
  for (let d = 1; d <= daysInMonth; d++) {
    const zdt = searchZdt.with({ day: d });
    if (zdt.dayOfWeek % 7 === targetDay) {
      count++;
      if (count === ordinal) return zdt;
    }
  }
  return null;
}

function dateMatchesSpec(
  zdt: Temporal.ZonedDateTime,
  ordinal: number,
  target: string,
  period: string,
): boolean {
  // Check period (month match)
  if (period !== "month") {
    const targetMonth = MONTH_NAMES.indexOf(
      period as typeof MONTH_NAMES[number],
    ) + 1; // 1-indexed in Temporal
    if (zdt.month !== targetMonth) return false;
  }

  // Check target (day/weekday match)
  const expected = findOrdinalInMonth(
    zdt,
    ordinal,
    target,
  );
  if (!expected) return false;

  return (
    zdt.day === expected.day &&
    zdt.month === expected.month
  );
}

function parseWeekdayList(expr: string): number[] | null {
  if (/^(?:week|work)days?$/.test(expr)) {
    return [1, 2, 3, 4, 5];
  }

  if (!/^[a-z]+(?:\s*,\s*[a-z]+)*$/.test(expr)) {
    return null;
  }

  const parts = expr.split(",").map((s) => s.trim());
  const dayIndices: number[] = [];

  for (const part of parts) {
    const longIndex = DAY_NAMES.indexOf(part as typeof DAY_NAMES[number]);
    if (longIndex !== -1) {
      dayIndices.push(longIndex);
      continue;
    }
    const shortIndex = SHORT_DAY_NAMES.indexOf(
      part as typeof SHORT_DAY_NAMES[number],
    );
    if (shortIndex !== -1) {
      dayIndices.push(shortIndex);
      continue;
    }
    return null; // Invalid day name
  }

  return Array.from(new Set(dayIndices)).sort((a, b) => a - b);
}

function computeNextWeekday(
  zdt: Temporal.ZonedDateTime,
  dayIndices: number[],
): Temporal.ZonedDateTime {
  const currentDay = zdt.dayOfWeek % 7; // Map 1-7 to 0-6
  let daysToAdd = 1;
  for (; daysToAdd <= 7; daysToAdd++) {
    const target = (currentDay + daysToAdd) % 7;
    if (dayIndices.includes(target)) {
      break;
    }
  }

  return zdt.add({ days: daysToAdd });
}
