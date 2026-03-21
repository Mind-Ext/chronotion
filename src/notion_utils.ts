/**
 * Notion Utility functions and schema definitions for Chronotion.
 *
 * These functions are pure or primarily concerned with data transformation,
 * making them easy to test without a real Notion API.
 */

import * as log from "@std/log";
import type { JobStatus } from "./types.ts";
import { JOB_STATUSES } from "./types.ts";

// ─── Environment Configuration ──────────────────────────────────────

/**
 * Validate that required Notion environment variables are present.
 * Logs a fatal error and exits the process if validation fails.
 */
export function validateNotionEnvVars(): {
  apiKey: string;
  databaseId: string;
} {
  const apiKey = Deno.env.get("NOTION_API_KEY");
  const databaseId = Deno.env.get("NOTION_DATABASE_ID") ||
    Deno.env.get("NOTION_TEST_DATABASE_ID");

  if (!apiKey || !databaseId) {
    const missing = [];
    if (!apiKey) missing.push("NOTION_API_KEY");
    if (!databaseId) missing.push("NOTION_DATABASE_ID");

    const logger = log.getLogger();
    logger.error(
      `Fatal: Missing required environment variables for Notion mode: ${
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

/** Safely extract a date string from a Notion date property. */
export function getDateString(
  prop: { type: "date"; date: { start: string } | null } | undefined,
): string | null {
  const start = prop?.date?.start;
  if (!start) return null;

  // Preserve date-only format (YYYY-MM-DD)
  if (start.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return start;
  }

  // Normalize date-time strings to full ISO format (e.g. normalize +00:00 to Z)
  try {
    return new Date(start).toISOString();
  } catch {
    return start;
  }
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
  run_at: { date: {} },
  next_in: { rich_text: {} },
  end_on: { date: {} },
  status: {
    select: {
      options: JOB_STATUSES.map((s) => ({ name: s, color: STATUS_COLORS[s] })),
    },
  },
  uid: { rich_text: {} },
  prev_instance: { relation: { database_id: "SELF", single_property: {} } },
  next_instance: { relation: { database_id: "SELF", single_property: {} } },
  timeout_minutes: { number: { format: "number" } },
};
