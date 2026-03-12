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
    assertEquals(result.next.toISOString(), "2024-06-16T10:00:00.000Z");
  }
});

Deno.test("interval: 3 days", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "3 days");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.toISOString(), "2024-06-18T10:00:00.000Z");
  }
});

Deno.test("interval: 2 weeks", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "2w");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.toISOString(), "2024-06-29T10:00:00.000Z");
  }
});

Deno.test("interval: 1 month", () => {
  const anchor = new Date("2024-01-31T10:00:00Z");
  const result = computeNextRun(anchor, "1 month");
  assertEquals(result.ok, true);
  if (result.ok) {
    // JS Date: Jan 31 + 1 month = Mar 2 (Feb has 29 days in 2024)
    assertEquals(result.next.getMonth(), 2); // March (0-indexed)
  }
});

Deno.test("interval: 1 year", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "1 year");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.toISOString(), "2025-06-15T10:00:00.000Z");
  }
});

// --- Macro tests ---

Deno.test("macro: first monday of month", () => {
  const anchor = new Date("2024-06-03T10:00:00Z"); // June 3 is the first Monday
  const result = computeNextRun(anchor, "first monday of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    // Next first Monday is July 1, 2024
    assertEquals(result.next.getMonth(), 6); // July
    assertEquals(result.next.getDate(), 1);
  }
});

Deno.test("macro: last day of month", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "last day of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.getMonth(), 5); // June
    assertEquals(result.next.getDate(), 30);
  }
});

Deno.test("macro: first day of january", () => {
  const anchor = new Date("2024-06-15T10:00:00Z");
  const result = computeNextRun(anchor, "first day of january");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.getFullYear(), 2025);
    assertEquals(result.next.getMonth(), 0);
    assertEquals(result.next.getDate(), 1);
  }
});

Deno.test("macro: 3rd friday of month", () => {
  const anchor = new Date("2024-06-01T10:00:00Z");
  const result = computeNextRun(anchor, "3rd friday of month");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.next.getMonth(), 5); // June
    assertEquals(result.next.getDate(), 21); // 3rd Friday of June 2024
    assertEquals(result.next.getDay(), 5); // Friday
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
  assertEquals(validateNextIn("1d"), null);
  assertEquals(validateNextIn("3 weeks"), null);
  assertEquals(validateNextIn("never"), null);
  assertEquals(validateNextIn("first monday of month"), null);
  assertEquals(validateNextIn("last day of january"), null);
});

Deno.test("validateNextIn: invalid expressions", () => {
  assertEquals(typeof validateNextIn("every day"), "string");
  assertEquals(typeof validateNextIn("abc"), "string");
  assertEquals(typeof validateNextIn("0d"), "string");
  assertEquals(typeof validateNextIn("0 months"), "string");
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
