/**
 * Notion Utility functions and schema definitions for Chronotion.
 *
 * These functions are pure or primarily concerned with data transformation,
 * making them easy to test without a real Notion API.
 */

import * as log from "@std/log";
import type { AppConfig, JobStatus } from "./types.ts";
import { JOB_STATUSES } from "./types.ts";

// ─── Environment Configuration ──────────────────────────────────────

/**
 * Validate that required Notion environment variables or config settings are present.
 * Logs a fatal error and exits the process if validation fails.
 */
export function validateNotionEnvVars(config?: AppConfig): {
  apiKey: string;
  databaseId: string;
} {
  const apiKey = config?.notion_api_key || Deno.env.get("NOTION_API_KEY");
  const databaseId = config?.notion_database_id ||
    Deno.env.get("NOTION_DATABASE_ID") ||
    Deno.env.get("NOTION_TEST_DATABASE_ID");

  if (!apiKey || !databaseId) {
    const missing = [];
    if (!apiKey) missing.push("notion_api_key (or NOTION_API_KEY env)");
    if (!databaseId) {
      missing.push("notion_database_id (or NOTION_DATABASE_ID env)");
    }

    const logger = log.getLogger();
    logger.error(
      `Fatal: Missing required credentials for Notion mode: ${
        missing.join(
          ", ",
        )
      }`,
    );
    Deno.exit(1);
  }

  return { apiKey, databaseId };
}

// ─── Output Truncation ───────────────────────────────────────────────

export const MAX_RICH_TEXT_LENGTH = 2000;
export const TRUNCATION_TARGET = 1950;

/**
 * Truncate output for Notion's 2,000-character rich text limit.
 * Keeps the last 1,950 characters and prepends a truncation marker.
 */
export function truncateOutput(output: string): string {
  if (output.length <= MAX_RICH_TEXT_LENGTH) return output;
  const skipped = output.length - TRUNCATION_TARGET;
  const tail = output.slice(-TRUNCATION_TARGET);
  return `[... ${skipped} characters truncated ...]\n${tail}`;
}

/**
 * Parse an argument string. Supports JSON arrays or simple space-separated strings.
 */
export function parseStringArgs(raw: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      // Fallback to simple space split if JSON is invalid
      return trimmed.split(/\s+/).filter(Boolean);
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

// ─── Property Extraction Helpers ─────────────────────────────────────

/** Safely extract plain text from a Notion rich_text or title array. */
export function getPlainText(
  prop:
    | {
      type: "rich_text" | "title";
      rich_text?: Array<{ plain_text: string }>;
      title?: Array<{ plain_text: string }>;
    }
    | undefined,
): string {
  if (!prop) return "";
  const arr = prop.type === "title" ? prop.title : prop.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((t) => t.plain_text).join("");
}

/**
 * Strip a trailing Temporal-style timezone bracket suffix (e.g. `[America/New_York]`)
 * from a date string. Returns the string unchanged if no bracket is present.
 */
export function stripTzBracket(str: string): string {
  return str.replace(/\[[^\]]+\]$/, "");
}

/**
 * Safely extract a date string from a Notion date property.
 *
 * Returns a Temporal `ZonedDateTime.toString()` representation that preserves
 * timezone identity (e.g. `2026-06-08T00:55:00-04:00[America/New_York]`),
 * a plain ISO string for UTC dates, or the raw date-only string for `YYYY-MM-DD`.
 */
export function getDateString(
  prop:
    | { type: "date"; date: { start: string; time_zone?: string | null } | null }
    | undefined,
  defaultTimeZone?: string,
): string | null {
  const dateObj = prop?.date;
  if (!dateObj) return null;
  const start = dateObj.start;
  if (!start) return null;

  // Preserve date-only format (YYYY-MM-DD)
  if (start.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return start;
  }

  // Preserve timezone and offset if possible, otherwise normalize to ISO format
  try {
    const tz = dateObj.time_zone;
    if (tz) {
      if (tz === "UTC") {
        return new Date(start).toISOString();
      }
      const instant = Temporal.Instant.from(start);
      return instant.toZonedDateTimeISO(tz).toString();
    } else {
      // No named timezone — check if it's UTC first (avoids unnecessary Instant allocation)
      if (start.endsWith("Z") || start.includes("+00:00") || start.includes("-00:00")) {
        return new Date(start).toISOString();
      }
      const offsetMatch = start.match(/([+-]\d{2}:\d{2})$/);
      const offset = offsetMatch ? offsetMatch[1] : "UTC";
      if (offset === "UTC") {
        return new Date(start).toISOString();
      }
      const instant = Temporal.Instant.from(start);
      if (defaultTimeZone) {
        try {
          const zdt = instant.toZonedDateTimeISO(defaultTimeZone);
          if (zdt.offset === offset) {
            return zdt.toString();
          }
        } catch {
          // If defaultTimeZone is invalid/unknown, fall back to offset
        }
      }
      return instant.toZonedDateTimeISO(offset).toString();
    }
  } catch {
    try {
      return new Date(start).toISOString();
    } catch {
      return start;
    }
  }
}

/**
 * Parse a date string into a legacy `Date` object, stripping any trailing
 * Temporal bracket suffix first. Use this when you need epoch-millis comparison
 * but don't need timezone identity.
 */
export function parseDate(str: string): Date {
  return new Date(stripTzBracket(str));
}

/**
 * Parse a date string (possibly containing a bracketed timezone) into the
 * `{ start, time_zone }` shape expected by the Notion API date property.
 *
 * Named timezones (e.g. `[America/New_York]`) are passed through;
 * offset-only brackets (e.g. `[-04:00]`) are discarded since Notion
 * doesn't accept raw offsets as `time_zone`.
 */
export function parseNotionDateString(str: string): { start: string; time_zone: string | null } {
  const tzMatch = str.match(/\[([^\]]+)\]$/);
  const start = stripTzBracket(str);

  let timeZone: string | null = null;
  if (tzMatch) {
    const tz = tzMatch[1];
    // Notion only accepts valid named timezone identifiers (e.g. "America/New_York").
    // If the timezone bracket is just an offset (like "[-04:00]"), we leave time_zone as null.
    if (!tz.startsWith("+") && !tz.startsWith("-")) {
      timeZone = tz;
    }
  }

  return { start, time_zone: timeZone };
}

/** Safely extract a select value. */
export function getSelectValue(
  prop: { type: "select"; select: { name: string } | null } | undefined,
): string | null {
  return prop?.select?.name ?? null;
}

/** Safely extract a number value. */
export function getNumberValue(
  prop: { type: "number"; number: number | null } | undefined,
): number | null {
  return prop?.number ?? null;
}

/** Safely extract the first relation page ID. */
export function getRelationId(
  prop: { type: "relation"; relation: Array<{ id: string }> } | undefined,
): string | null {
  if (!prop?.relation || !Array.isArray(prop.relation)) return null;
  return prop.relation[0]?.id ?? null;
}

// ─── Push Logic Helpers ─────────────────────────────────────────────

/** Build a rich_text array from a plain string. */
export function richText(
  text: string,
): Array<{ type: "text"; text: { content: string } }> {
  if (!text) return [];
  return [{ type: "text", text: { content: text } }];
}

// ─── Database Schema Definition ─────────────────────────────────────

export const STATUS_COLORS: Record<Exclude<JobStatus, null>, string> = {
  pending: "purple",
  running: "blue",
  success: "green",
  failed: "red",
  error: "orange",
  disabled: "brown",
  skipped: "gray",
  missed: "yellow",
};

/** Required properties and their Notion types. */
export const REQUIRED_PROPERTIES: Record<string, object> = {
  // "name" is the title property — databases always have one
  name: { title: {} },
  script: { rich_text: {} },
  args: { rich_text: {} },
  deno_args: { rich_text: {} },
  scheduled_at: { date: {} },
  finished_at: { date: {} },
  next_in: { rich_text: {} },
  end_on: { date: {} },
  status: {
    select: {
      options: JOB_STATUSES.map((s) => ({ name: s, color: STATUS_COLORS[s] })),
    },
  },
  worker_id: { select: {} },
  uid: { rich_text: {} },
  prev_instance: { relation: { database_id: "SELF", single_property: {} } },
  next_instance: { relation: { database_id: "SELF", single_property: {} } },
  timeout_minutes: { number: { format: "number" } },
};
