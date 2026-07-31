/**
 * Schedule and date math for next_in interval/macro resolution.
 *
 * Supported formats:
 *   Intervals: "N d/day/days", "N w/week/weeks", "N m/month/months", "N y/yr/year/years"
 *   Macros: "first/second/3rd/../last day/monday/.. of month/january/.."
 *   Weekdays: "mon,wed,fri", "workdays"
 *   Boolean expressions: "workday & (1st day of month, 15th day of month)", "mon AND last day of month"
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

export type ScheduleResult =
  | { ok: true; next: Temporal.ZonedDateTime }
  | { ok: false; error: string };

export type ASTNode =
  | { type: "OR"; left: ASTNode; right: ASTNode }
  | { type: "AND"; left: ASTNode; right: ASTNode }
  | { type: "WEEKDAY"; dayIndices: number[] }
  | { type: "MACRO"; spec: MacroSpec };

interface Token {
  kind: "LPAREN" | "RPAREN" | "AND" | "OR" | "PRIM";
  value?: string;
}

interface Parser {
  tokens: Token[];
  pos: number;
}

function toZonedDateTime(anchor: Date | string): Temporal.ZonedDateTime {
  if (typeof anchor === "string") {
    let str = anchor.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      str += "T00:00:00Z";
    }
    const tzMatch = str.match(/\[([^\]]+)\]$/);
    const offsetMatch = str.match(/([+-]\d{2}:\d{2})$/);
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
  maxSearchDays = 1096,
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

  // Try declarative AST format (macros, weekdays, AND, OR, parentheses)
  const ast = parseDeclarativeAST(expr);
  if (ast) {
    return computeNextDeclarative(zdt, ast, maxSearchDays);
  }

  return { ok: false, error: `Invalid next_in expression: "${nextIn}"` };
}

/** Validate a next_in expression without computing a date */
export function validateNextIn(nextIn: string): [boolean, string] {
  const expr = nextIn.trim().toLowerCase();
  if (expr === "never" || expr === "") return [true, ""];

  // Check interval
  const intervalMatch = expr.match(
    /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|yr|year|years)$/,
  );
  if (intervalMatch) {
    if (parseInt(intervalMatch[1], 10) === 0) {
      return [false, `Interval count must be greater than zero: "${nextIn}"`];
    }
    return [true, ""];
  }

  // Check declarative AST
  if (parseDeclarativeAST(expr) !== null) {
    return [true, ""];
  }

  return [false, `Invalid next_in expression: "${nextIn}"`];
}

/** Check if a date matches a macro or declarative expression */
export function dateMatchesMacro(date: Date, nextIn: string): boolean {
  const expr = nextIn.trim().toLowerCase();
  const ast = parseDeclarativeAST(expr);
  if (!ast) return true; // Not a declarative macro/expression, no validation needed

  const zdt = toZonedDateTime(date);
  return dateMatchesNode(zdt, ast);
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
    /^(first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s+(\w+)\s+of\s+(\w+)$/,
  );
  if (!match) return null;

  const [, ordStr, target, period] = match;

  let ordinal: number;
  if (ordStr in ORDINAL_MAP) {
    ordinal = ORDINAL_MAP[ordStr];
  } else {
    ordinal = parseInt(ordStr, 10);
  }

  if (
    target !== "day" &&
    target !== "workday" &&
    !DAY_NAMES.includes(target as typeof DAY_NAMES[number]) &&
    !SHORT_DAY_NAMES.includes(target as typeof SHORT_DAY_NAMES[number])
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

function parsePrimitive(str: string): ASTNode | null {
  const s = str.trim().toLowerCase();
  if (!s) return null;

  const macroSpec = parseMacroSpec(s);
  if (macroSpec) {
    return { type: "MACRO", spec: macroSpec };
  }

  const dayIndices = weekdayToIndices(s);
  if (dayIndices && dayIndices.length > 0) {
    return { type: "WEEKDAY", dayIndices };
  }

  return null;
}

function tokenize(expr: string): Token[] | null {
  let clean = expr.trim();
  clean = clean.replace(/&&|&/g, " AND ");
  clean = clean.replace(/,/g, " OR ");
  clean = clean.replace(/\(/g, " ( ").replace(/\)/g, " ) ");

  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;

  const tokens: Token[] = [];
  let currentPrimWords: string[] = [];

  const flushPrim = () => {
    if (currentPrimWords.length > 0) {
      tokens.push({ kind: "PRIM", value: currentPrimWords.join(" ") });
      currentPrimWords = [];
    }
  };

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower === "and") {
      if (currentPrimWords.length === 0 && tokens.length === 0) return null;
      flushPrim();
      tokens.push({ kind: "AND" });
    } else if (lower === "or") {
      if (currentPrimWords.length === 0 && tokens.length === 0) return null;
      flushPrim();
      tokens.push({ kind: "OR" });
    } else if (word === "(") {
      flushPrim();
      tokens.push({ kind: "LPAREN" });
    } else if (word === ")") {
      flushPrim();
      tokens.push({ kind: "RPAREN" });
    } else {
      currentPrimWords.push(word);
    }
  }
  flushPrim();

  return tokens;
}

function parseExpr(p: Parser): ASTNode | null {
  let left = parseAndExpr(p);
  if (!left) return null;

  while (p.pos < p.tokens.length && p.tokens[p.pos].kind === "OR") {
    p.pos++; // consume OR
    const right = parseAndExpr(p);
    if (!right) return null;
    left = { type: "OR", left, right };
  }

  return left;
}

function parseAndExpr(p: Parser): ASTNode | null {
  let left = parseFactor(p);
  if (!left) return null;

  while (p.pos < p.tokens.length && p.tokens[p.pos].kind === "AND") {
    p.pos++; // consume AND
    const right = parseFactor(p);
    if (!right) return null;
    left = { type: "AND", left, right };
  }

  return left;
}

function parseFactor(p: Parser): ASTNode | null {
  if (p.pos >= p.tokens.length) return null;

  const token = p.tokens[p.pos];
  if (token.kind === "LPAREN") {
    p.pos++; // consume (
    const expr = parseExpr(p);
    if (!expr) return null;
    if (p.pos >= p.tokens.length || p.tokens[p.pos].kind !== "RPAREN") {
      return null;
    }
    p.pos++; // consume )
    return expr;
  }

  if (token.kind === "PRIM" && token.value) {
    p.pos++;
    return parsePrimitive(token.value);
  }

  return null;
}

export function parseDeclarativeAST(expr: string): ASTNode | null {
  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return null;
  const p: Parser = { tokens, pos: 0 };
  const ast = parseExpr(p);
  if (!ast) return null;
  if (p.pos < p.tokens.length) return null; // Trailing unparsed tokens
  return ast;
}

function dateMatchesNode(zdt: Temporal.ZonedDateTime, node: ASTNode): boolean {
  switch (node.type) {
    case "OR":
      return dateMatchesNode(zdt, node.left) ||
        dateMatchesNode(zdt, node.right);
    case "AND":
      return dateMatchesNode(zdt, node.left) &&
        dateMatchesNode(zdt, node.right);
    case "WEEKDAY": {
      const currentDay = zdt.dayOfWeek % 7;
      return node.dayIndices.includes(currentDay);
    }
    case "MACRO":
      return dateMatchesSpec(
        zdt,
        node.spec.ordinal,
        node.spec.target,
        node.spec.period,
      );
  }
}

function computeNextDeclarative(
  anchor: Temporal.ZonedDateTime,
  ast: ASTNode,
  maxSearchDays = 1096,
): ScheduleResult {
  let searchZdt = anchor.add({ days: 1 });
  for (let i = 0; i < maxSearchDays; i++) {
    if (dateMatchesNode(searchZdt, ast)) {
      return { ok: true, next: searchZdt };
    }
    searchZdt = searchZdt.add({ days: 1 });
  }
  return { ok: false, error: `Could not find next occurrence for AST` };
}

function findOrdinalInMonth(
  searchZdt: Temporal.ZonedDateTime,
  ordinal: number,
  target: string,
): Temporal.ZonedDateTime | null {
  if (target === "day") {
    const daysInMonth = searchZdt.daysInMonth;
    if (ordinal === -1) {
      return searchZdt.with({ day: daysInMonth });
    }
    if (ordinal > daysInMonth) return null;
    return searchZdt.with({ day: ordinal });
  }

  if (target === "workday") {
    const daysInMonth = searchZdt.daysInMonth;
    if (ordinal === -1) {
      for (let d = daysInMonth; d >= 1; d--) {
        const zdt = searchZdt.with({ day: d });
        const dow = zdt.dayOfWeek % 7;
        if (dow >= 1 && dow <= 5) return zdt;
      }
      return null;
    }

    let count = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const zdt = searchZdt.with({ day: d });
      const dow = zdt.dayOfWeek % 7;
      if (dow >= 1 && dow <= 5) {
        count++;
        if (count === ordinal) return zdt;
      }
    }
    return null;
  }

  let targetDay = DAY_NAMES.indexOf(target as typeof DAY_NAMES[number]);
  if (targetDay === -1) {
    targetDay = SHORT_DAY_NAMES.indexOf(
      target as typeof SHORT_DAY_NAMES[number],
    );
  }
  if (targetDay === -1) return null;

  if (ordinal === -1) {
    const daysInMonth = searchZdt.daysInMonth;
    for (let d = daysInMonth; d >= 1; d--) {
      const zdt = searchZdt.with({ day: d });
      if (zdt.dayOfWeek % 7 === targetDay) return zdt;
    }
    return null;
  }

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
  if (period !== "month") {
    const targetMonth = MONTH_NAMES.indexOf(
      period as typeof MONTH_NAMES[number],
    ) + 1;
    if (zdt.month !== targetMonth) return false;
  }

  const expected = findOrdinalInMonth(zdt, ordinal, target);
  if (!expected) return false;

  return zdt.day === expected.day && zdt.month === expected.month;
}

function weekdayToIndices(expr: string): number[] | null {
  if (/^(?:week|work)days?$/.test(expr)) {
    return [1, 2, 3, 4, 5];
  }

  const longIndex = DAY_NAMES.indexOf(expr as typeof DAY_NAMES[number]);
  if (longIndex !== -1) {
    return [longIndex];
  }

  const shortIndex = SHORT_DAY_NAMES.indexOf(
    expr as typeof SHORT_DAY_NAMES[number],
  );
  if (shortIndex !== -1) {
    return [shortIndex];
  }

  return null;
}
