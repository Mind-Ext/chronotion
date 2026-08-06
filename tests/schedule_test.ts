import { assertEquals } from "@std/assert";
import {
  computeNextRun,
  dateMatchesMacro,
  validateNextIn,
} from "../src/schedule.ts";

// --- Interval tests ---

Deno.test("interval: 1 day", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "1d");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2024-06-16T10:00:00.000Z",
    );
  }
});

Deno.test("interval: 3 days", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "3 days");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2024-06-18T10:00:00.000Z",
    );
  }
});

Deno.test("interval: 2 weeks", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "2w");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2024-06-29T10:00:00.000Z",
    );
  }
});

Deno.test("interval: 1 month", () => {
  const anchor = new Date("2024-01-31T10:00:00Z");
  const result = computeNextRun(anchor, "1 month");
  assertEquals(result.ok, true);
  if (result.ok) {
    // Temporal clamps to end of month: Jan 31 + 1 month = Feb 29 (Feb has 29 days in 2024)
    assertEquals(result.next.month, 2); // February (1-indexed in Temporal)
  }
});

Deno.test("interval: 1 year", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "1 year");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2025-06-15T10:00:00.000Z",
    );
  }
});

// --- Macro tests ---

Deno.test("macro: first monday of month", () => {
  const anchor = new Date("2024-06-03T10:00:00Z"); // June 3 is the first Monday
  const result = computeNextRun(anchor, "first monday of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    // Next first Monday is July 1, 2024
    assertEquals(result.next.month, 7); // July (1-indexed)
    assertEquals(result.next.day, 1);
  }
});

Deno.test("macro: last day of month", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "last day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6); // June (1-indexed)
    assertEquals(result.next.day, 30);
  }
});

Deno.test("macro: first day of january", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "first day of january");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.year, 2025);
    assertEquals(result.next.month, 1); // January (1-indexed)
    assertEquals(result.next.day, 1);
  }
});

Deno.test("macro: 3rd friday of month", () => {
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "3rd friday of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6); // June (1-indexed)
    assertEquals(result.next.day, 21); // 3rd Friday of June 2024
    assertEquals(result.next.dayOfWeek, 5); // Friday (1=Mon..7=Sun)
  }
});

Deno.test("macro: 1st wed of month (short day name)", () => {
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "1st wed of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 5);
  }
});

Deno.test("macro: first workday of month", () => {
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "first workday of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 3);
  }
});

Deno.test("macro: last workday of month", () => {
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "last workday of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 28);
  }
});

Deno.test("macro: range (15th to 18th day of month)", () => {
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "15th to 18th day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 15);
  }
});

Deno.test("macro: range (15-18 day of month) combined with boolean", () => {
  // 15th to 18th of June 2024: 15(Sat), 16(Sun), 17(Mon), 18(Tue)
  // Workdays in that range: 17th and 18th.
  // We want next occurrence after June 1. It should be Monday June 17.
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "workday AND 15-18 day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 17);
  }
});

Deno.test("macro: range with ordinal targets (1-3 sat of month)", () => {
  // June 1 2024 is the 1st Saturday.
  // Next match should be the 2nd Saturday (June 8).
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "1-3 sat of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 8); // June 8th
  }
});

Deno.test("macro: range with workday target (15-18 workday of month)", () => {
  // June 2024 workdays: 3-7 (1-5), 10-14 (6-10), 17-21 (11-15).
  // The 15th workday is June 21.
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "15-18 workday of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 21); // June 21st
  }
});

// --- Special cases ---

Deno.test("never returns error", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "never");
  assertEquals(result.ok, false);
});

Deno.test("empty string returns error", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "");
  assertEquals(result.ok, false);
});

Deno.test("invalid expression returns error", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "every tuesday");
  assertEquals(result.ok, false);
});

// --- Validation ---

Deno.test("validateNextIn: valid expressions", () => {
  assertEquals(validateNextIn("1d"), [true, ""]);
  assertEquals(validateNextIn("3 weeks"), [true, ""]);
  assertEquals(validateNextIn("never"), [true, ""]);
  assertEquals(validateNextIn(""), [true, ""]);
  assertEquals(validateNextIn("first monday of month"), [true, ""]);
  assertEquals(validateNextIn("last day of january"), [true, ""]);
  assertEquals(validateNextIn("last workday of month"), [true, ""]);
  assertEquals(validateNextIn("1st wed of month"), [true, ""]);
  assertEquals(validateNextIn("15th to 18th day of month"), [true, ""]);
  assertEquals(validateNextIn("15-18 day of month"), [true, ""]);
  assertEquals(validateNextIn("1-3 sat of month"), [true, ""]);
  assertEquals(validateNextIn("15-18 workday of month"), [true, ""]);
});

Deno.test("validateNextIn: invalid expressions", () => {
  assertEquals(validateNextIn("every day")[0], false);
  assertEquals(validateNextIn("abc")[0], false);
  assertEquals(validateNextIn("0d")[0], false);
  assertEquals(validateNextIn("0 months")[0], false);
});

// --- Macro matching ---

Deno.test("dateMatchesMacro: correct date", () => {
  const date = new Date("2024-06-03T10:00:00Z"); // First Monday of June
  assertEquals(dateMatchesMacro(date, "first monday of month"), true);
});

Deno.test("dateMatchesMacro: wrong date", () => {
  const date = new Date("2024-06-04T10:00:00Z"); // Tuesday
  assertEquals(dateMatchesMacro(date, "first monday of month"), false);
});

Deno.test("dateMatchesMacro: non-macro returns true", () => {
  const date = new Date("2024-06-04T10:00:00Z");
  assertEquals(dateMatchesMacro(date, "1d"), true);
});

// --- Weekday list tests ---

Deno.test("weekday list: mon,wed", () => {
  const anchor = new Date("2024-06-17T10:00:00Z"); // Monday
  const result = computeNextRun(anchor, "mon,wed");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2024-06-19T10:00:00.000Z",
    ); // Wednesday
  }
});

Deno.test("weekday list: wednesday, friday (from Wednesday)", () => {
  const anchor = new Date("2024-06-19T10:00:00Z"); // Wednesday
  const result = computeNextRun(anchor, "wednesday, friday");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2024-06-21T10:00:00.000Z",
    ); // Friday
  }
});

Deno.test("weekday list: single weekday (monday from monday)", () => {
  const anchor = new Date("2024-06-17T10:00:00Z"); // Monday
  const result = computeNextRun(anchor, "mon");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2024-06-24T10:00:00.000Z",
    ); // Next Monday
  }
});

Deno.test("weekday list: mixed casing and whitespace", () => {
  const anchor = new Date("2024-06-17T10:00:00Z"); // Monday
  const result = computeNextRun(anchor, "  tue ,  Fri  ");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(
      new Date(result.next.epochMilliseconds).toISOString(),
      "2024-06-18T10:00:00.000Z",
    ); // Tuesday
  }
});

Deno.test("validateNextIn: valid weekday lists", () => {
  assertEquals(validateNextIn("mon,wed,fri"), [true, ""]);
  assertEquals(validateNextIn("monday, wednesday"), [true, ""]);
  assertEquals(validateNextIn("tue"), [true, ""]);
  assertEquals(validateNextIn("  sunday  "), [true, ""]);
});

Deno.test("validateNextIn: invalid weekday lists", () => {
  assertEquals(validateNextIn("mon,invalid")[0], false);
  assertEquals(validateNextIn("mon, wed, 123")[0], false);
});

Deno.test("weekday list: weekday/workday aliases", () => {
  // Friday
  const anchorFri = new Date("2024-06-21T10:00:00Z");
  const resultFri = computeNextRun(anchorFri, "weekday");
  assertEquals(resultFri.ok, true);
  if (resultFri.ok) {
    assertEquals(
      new Date(resultFri.next.epochMilliseconds).toISOString(),
      "2024-06-24T10:00:00.000Z",
    ); // Next Monday
  }

  // Saturday
  const anchorSat = new Date("2024-06-22T10:00:00Z");
  const resultSat = computeNextRun(anchorSat, "weekdays");
  assertEquals(resultSat.ok, true);
  if (resultSat.ok) {
    assertEquals(
      new Date(resultSat.next.epochMilliseconds).toISOString(),
      "2024-06-24T10:00:00.000Z",
    ); // Next Monday
  }

  // Monday
  const anchorMon = new Date("2024-06-17T10:00:00Z");
  const resultMon = computeNextRun(anchorMon, "workday");
  assertEquals(resultMon.ok, true);
  if (resultMon.ok) {
    assertEquals(
      new Date(resultMon.next.epochMilliseconds).toISOString(),
      "2024-06-18T10:00:00.000Z",
    ); // Tuesday
  }
});

Deno.test("validateNextIn: valid weekday aliases", () => {
  assertEquals(validateNextIn("weekday"), [true, ""]);
  assertEquals(validateNextIn("weekdays"), [true, ""]);
  assertEquals(validateNextIn("workday"), [true, ""]);
  assertEquals(validateNextIn("workdays"), [true, ""]);
});

// --- Timezone-aware scheduling tests ---

Deno.test("timezone string anchor: preserves timezone through interval", () => {
  // Anchor is 10 PM Eastern (UTC-4 in June due to EDT)
  const anchor = "2024-06-15T22:00:00-04:00[America/New_York]";
  const result = computeNextRun(anchor, "1d");
  assertEquals(result.ok, true);
  if (result.ok) {
    // next should preserve the America/New_York timezone
    const zdtStr = result.next.toString();
    assertEquals(zdtStr.includes("[America/New_York]"), true);
    // Should be June 16 at 22:00 Eastern
    assertEquals(result.next.day, 16);
    assertEquals(result.next.hour, 22);
  }
});

Deno.test("timezone string anchor: DST spring-forward preserves wall clock time", () => {
  // March 9, 2025 at 10:00 AM Eastern — DST springs forward on March 9
  // Adding 1 day should land on March 10 at 10:00 AM EDT (offset changes -05:00 → -04:00)
  const anchor = "2025-03-08T10:00:00-05:00[America/New_York]";
  const result = computeNextRun(anchor, "1d");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.hour, 10); // Wall clock stays at 10 AM
    assertEquals(result.next.day, 9);
    // The offset should have changed from -05:00 to -04:00
    const zdtStr = result.next.toString();
    assertEquals(zdtStr.includes("-04:00"), true);
  }
});

Deno.test("timezone string anchor: monthly interval clamps correctly", () => {
  // Jan 31 in US/Eastern + 1 month should clamp to Feb 28 (2025 is not a leap year)
  const anchor = "2025-01-31T09:00:00-05:00[America/New_York]";
  const result = computeNextRun(anchor, "1 month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 2); // February
    assertEquals(result.next.day, 28);
    assertEquals(result.next.hour, 9);
    assertEquals(result.next.toString().includes("[America/New_York]"), true);
  }
});

Deno.test("timezone string anchor: weekday list preserves timezone", () => {
  // Monday June 17 2024, 9 AM Tokyo time
  const anchor = "2024-06-17T09:00:00+09:00[Asia/Tokyo]";
  const result = computeNextRun(anchor, "wed,fri");
  assertEquals(result.ok, true);
  if (result.ok) {
    // Next Wednesday is June 19
    assertEquals(result.next.day, 19);
    assertEquals(result.next.hour, 9);
    assertEquals(result.next.toString().includes("[Asia/Tokyo]"), true);
  }
});

Deno.test("timezone string anchor: macro preserves timezone", () => {
  // June 1 2024, 8 AM in London
  const anchor = "2024-06-01T08:00:00+01:00[Europe/London]";
  const result = computeNextRun(anchor, "last day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.day, 30); // June has 30 days
    assertEquals(result.next.hour, 8);
    assertEquals(result.next.toString().includes("[Europe/London]"), true);
  }
});

// --- Declarative Boolean Expression tests (AND, OR, &, &&, commas, parentheses) ---

Deno.test("boolean logic: AND expression (monday AND 1st day of month)", () => {
  // June 1 2024 is Saturday. July 1 2024 is Monday!
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "monday AND 1st day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 7); // July
    assertEquals(result.next.day, 1);
    assertEquals(result.next.dayOfWeek, 1); // Monday
  }
});

Deno.test("boolean logic: ampersand & and parentheses (workdays & (1st day of month, 15th day of month))", () => {
  // June 1 2024 is Saturday. June 15 2024 is Saturday.
  // Next 1st or 15th of month that falls on a workday:
  // July 1 2024 (Monday) is 1st of month and a workday!
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(
    anchor,
    "workdays & (1st day of month, 15th day of month)",
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 7); // July
    assertEquals(result.next.day, 1);
  }
});

Deno.test("boolean logic: double ampersand && (friday && last day of month)", () => {
  // May 31 2024 is a Friday and the last day of May!
  const anchor = new Date("2024-05-01T10:00:00Z");
  const result = computeNextRun(anchor, "friday && last day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 5); // May
    assertEquals(result.next.day, 31);
    assertEquals(result.next.dayOfWeek, 5); // Friday
  }
});

Deno.test("boolean logic: comma as OR with macro (1st day of month, 15th day of month)", () => {
  // From June 2 2024, next is June 15
  const anchor = new Date("2024-06-02T10:00:00Z");
  const result = computeNextRun(anchor, "1st day of month, 15th day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 6);
    assertEquals(result.next.day, 15);
  }
});

Deno.test("boolean logic: nested parentheses", () => {
  // July 1 2024 is Monday. July 2 2024 is Tuesday.
  // Both match the respective sides of the OR.
  // With anchor May 31 2024, the earliest is July 1.
  const anchor = new Date("2024-05-31T10:00:00Z");
  const result = computeNextRun(
    anchor,
    "((mon OR wed) AND 1st day of month) OR (tue AND 2nd day of month)",
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.month, 7);
    assertEquals(result.next.day, 1);
  }

  // With anchor July 1 2024 at noon, the next match is July 2.
  const anchor2 = new Date("2024-07-01T12:00:00Z");
  const result2 = computeNextRun(
    anchor2,
    "((mon OR wed) AND 1st day of month) OR (tue AND 2nd day of month)",
  );
  assertEquals(result2.ok, true);
  if (result2.ok) {
    assertEquals(result2.next.month, 7);
    assertEquals(result2.next.day, 2);
  }
});

Deno.test("validateNextIn: valid boolean expressions", () => {
  assertEquals(
    validateNextIn("workdays & (1st day of month, 15th day of month)"),
    [true, ""],
  );
  assertEquals(validateNextIn("mon AND last day of month"), [true, ""]);
  assertEquals(validateNextIn("tue && 3rd friday of month"), [true, ""]);
  assertEquals(validateNextIn("(mon OR wed) AND 1st day of month"), [true, ""]);
  assertEquals(
    validateNextIn(
      "((mon OR wed) AND 1st day of month) OR (tue AND 2nd day of month)",
    ),
    [true, ""],
  );
});

Deno.test("validateNextIn: invalid boolean expressions", () => {
  // Cannot mix interval with boolean logic
  assertEquals(validateNextIn("1d OR mon")[0], false);
  assertEquals(validateNextIn("2w AND 1st day of month")[0], false);
  // Unmatched parens
  assertEquals(validateNextIn("(mon OR wed")[0], false);
  // Missing operands
  assertEquals(validateNextIn("mon AND")[0], false);
  assertEquals(validateNextIn("& wed")[0], false);
});

Deno.test("computeNextRun: maxSearchDays limit", () => {
  const anchor = new Date("2024-06-01T10:00:00Z");
  // If maxSearchDays is set to 3 days, "first day of january" cannot be reached
  const result = computeNextRun(anchor, "first day of january", 3);
  assertEquals(result.ok, false);
});
