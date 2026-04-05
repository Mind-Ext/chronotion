/**
 * Schedule and date math for next_in interval/macro resolution.
 *
 * Supported formats:
 *   Intervals: "N d/day/days", "N w/week/weeks", "N m/month/months", "N y/yr/year/years"
 *   Macros: "first/second/3rd/../last day/monday/.. of month/january/.."
 *   Special: "never" (one-off, no rescheduling)
 */

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
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
  | { ok: true; next: Date }
  | { ok: false; error: string };

/** Compute next scheduled_at from the given anchor date and next_in expression */
export function computeNextRun(
  anchor: Date,
  nextIn: string,
): ScheduleResult {
  const expr = nextIn.trim().toLowerCase();

  if (expr === "never" || expr === "") {
    return { ok: false, error: "never" };
  }

  // Try interval format: "N unit"
  const intervalResult = parseInterval(expr, anchor);
  if (intervalResult) return intervalResult;

  // Try macro format: "ordinal weekday/day of period"
  const macroResult = parseMacro(expr, anchor);
  if (macroResult) return macroResult;

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

  return `Invalid next_in expression: "${nextIn}"`;
}

/** Check if a date matches a macro expression (for first-instance validation) */
export function dateMatchesMacro(date: Date, nextIn: string): boolean {
  const result = parseMacroSpec(nextIn.trim().toLowerCase());
  if (!result) return true; // Not a macro, no validation needed

  const { ordinal, target, period } = result;
  return dateMatchesSpec(date, ordinal, target, period);
}

function parseInterval(expr: string, anchor: Date): ScheduleResult | null {
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
  const next = new Date(anchor);

  if (unit.startsWith("d")) {
    next.setDate(next.getDate() + count);
  } else if (unit.startsWith("w")) {
    next.setDate(next.getDate() + count * 7);
  } else if (unit.startsWith("m")) {
    next.setMonth(next.getMonth() + count);
  } else if (unit.startsWith("y")) {
    next.setFullYear(next.getFullYear() + count);
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

function parseMacro(expr: string, anchor: Date): ScheduleResult | null {
  const spec = parseMacroSpec(expr);
  if (!spec) return null;

  const { ordinal, target, period } = spec;

  // Determine the next occurrence AFTER the anchor
  // Start searching from the month after anchor (or the target month)
  let searchDate = new Date(anchor);

  for (let i = 0; i < 24; i++) {
    // Search up to 2 years ahead
    if (period === "month") {
      // Move to next month
      if (i > 0) searchDate.setMonth(searchDate.getMonth() + 1);
    } else {
      // Specific month — find the next occurrence of that month
      const targetMonth = MONTH_NAMES.indexOf(
        period as typeof MONTH_NAMES[number],
      );
      if (i === 0) {
        // Start from current year's target month, or next year if passed
        searchDate = new Date(anchor.getFullYear(), targetMonth, 1);
        if (searchDate <= anchor) {
          searchDate = new Date(anchor.getFullYear() + 1, targetMonth, 1);
        }
      } else {
        searchDate = new Date(
          searchDate.getFullYear() + 1,
          targetMonth,
          1,
        );
      }
    }

    const result = findOrdinalInMonth(
      searchDate.getFullYear(),
      searchDate.getMonth(),
      ordinal,
      target,
    );

    if (result && result > anchor) {
      // Preserve the time from the anchor
      result.setHours(
        anchor.getHours(),
        anchor.getMinutes(),
        anchor.getSeconds(),
        anchor.getMilliseconds(),
      );
      return { ok: true, next: result };
    }
  }

  return { ok: false, error: `Could not find next occurrence for "${expr}"` };
}

function findOrdinalInMonth(
  year: number,
  month: number,
  ordinal: number,
  target: string,
): Date | null {
  if (target === "day") {
    // Nth day of the month
    if (ordinal === -1) {
      // Last day
      return new Date(year, month + 1, 0);
    }
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    if (ordinal > daysInMonth) return null;
    return new Date(year, month, ordinal);
  }

  // Nth weekday of the month
  const targetDay = DAY_NAMES.indexOf(target as typeof DAY_NAMES[number]);
  if (targetDay === -1) return null;

  if (ordinal === -1) {
    // Last occurrence: start from end of month, walk backward
    const lastDay = new Date(year, month + 1, 0);
    for (let d = lastDay.getDate(); d >= 1; d--) {
      const date = new Date(year, month, d);
      if (date.getDay() === targetDay) return date;
    }
    return null;
  }

  // Find the Nth occurrence
  let count = 0;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    if (date.getDay() === targetDay) {
      count++;
      if (count === ordinal) return date;
    }
  }
  return null;
}

function dateMatchesSpec(
  date: Date,
  ordinal: number,
  target: string,
  period: string,
): boolean {
  // Check period (month match)
  if (period !== "month") {
    const targetMonth = MONTH_NAMES.indexOf(
      period as typeof MONTH_NAMES[number],
    );
    if (date.getMonth() !== targetMonth) return false;
  }

  // Check target (day/weekday match)
  const expected = findOrdinalInMonth(
    date.getFullYear(),
    date.getMonth(),
    ordinal,
    target,
  );
  if (!expected) return false;

  return (
    date.getDate() === expected.getDate() &&
    date.getMonth() === expected.getMonth()
  );
}
