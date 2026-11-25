/**
 * Read-only external entry inbox for Chronotion.
 *
 * External producers (or `deno task ingest --queue`) drop validated JSON files
 * into `local/inbox/`. The daemon drains them on each Notion sync cycle and
 * pushes them directly to Notion with a terminal status (NO_FETCH_STATUSES),
 * so they are never pulled back into `local/queue.json` or executed.
 */

import * as path from "@std/path";
import type { AppConfig } from "./types.ts";
import { NO_FETCH_STATUSES } from "./types.ts";
import { PROJECT_ROOT } from "./config.ts";
import {
  MAX_RICH_TEXT_LENGTH,
  parseDate,
  parseStringArgs,
  stripTzBracket,
} from "./notion_utils.ts";
import { createNotionInboxEntry } from "./notion.ts";
import { logger } from "./logger.ts";

export type TerminalJobStatus = (typeof NO_FETCH_STATUSES)[number];

export interface InboxEntry {
  uid: string;
  name: string;
  script: string;
  args: string[];
  status: TerminalJobStatus;
  scheduled_at: string;
  finished_at: string | null;
  worker_id: string;
  output: string;
}

export const DEFAULT_INBOX_DIR = path.join(PROJECT_ROOT, "local", "inbox");

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?(?:\[[^\]]+\])?)?$/;

const MAX_SELECT_NAME_LENGTH = 100;

function isValidDateString(value: string): boolean {
  const trimmed = value.trim();
  if (!ISO_DATE_RE.test(trimmed)) return false;

  const parsed = parseDate(trimmed);
  if (Number.isNaN(parsed.getTime())) return false;

  const tzMatch = trimmed.match(/\[([^\]]+)\]$/);
  if (tzMatch) {
    const tz = tzMatch[1];
    try {
      Temporal.Instant.from(stripTzBracket(trimmed)).toZonedDateTimeISO(tz);
    } catch {
      return false;
    }
  }

  return true;
}

function isPermanentNotionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 400
  );
}

/**
 * Validate and normalize a raw parsed JSON value into an InboxEntry.
 * Throws an Error with a clear message if validation fails.
 */
export function parseInboxEntry(raw: unknown): InboxEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Inbox entry must be a JSON object.");
  }

  const obj = raw as Record<string, unknown>;

  if (obj.name !== undefined && typeof obj.name !== "string") {
    throw new Error("Field 'name' must be a string.");
  }
  if (obj.script !== undefined && typeof obj.script !== "string") {
    throw new Error("Field 'script' must be a string.");
  }
  const nameRaw = typeof obj.name === "string" ? obj.name.trim() : "";
  const scriptRaw = typeof obj.script === "string" ? obj.script.trim() : "";
  if (!nameRaw && !scriptRaw) {
    throw new Error("At least one of 'name' or 'script' must be provided.");
  }

  const name = nameRaw || scriptRaw;
  if (name.length > MAX_RICH_TEXT_LENGTH) {
    throw new Error(
      `Field 'name' exceeds Notion's ${MAX_RICH_TEXT_LENGTH}-character limit.`,
    );
  }
  if (scriptRaw.length > MAX_RICH_TEXT_LENGTH) {
    throw new Error(
      `Field 'script' exceeds Notion's ${MAX_RICH_TEXT_LENGTH}-character limit.`,
    );
  }

  if (typeof obj.status !== "string") {
    throw new Error(
      `Field 'status' is required and must be one of: ${
        NO_FETCH_STATUSES.join(", ")
      }.`,
    );
  }
  const status = NO_FETCH_STATUSES.find((s) => s === obj.status);
  if (!status) {
    throw new Error(
      `Invalid status '${obj.status}'. Inbox entries must have a terminal status: ${
        NO_FETCH_STATUSES.join(", ")
      }.`,
    );
  }

  let workerId = "external";
  if (obj.worker_id !== undefined) {
    if (typeof obj.worker_id !== "string" || obj.worker_id.trim() === "") {
      throw new Error("Field 'worker_id' must be a non-empty string.");
    }
    workerId = obj.worker_id.trim();
    if (workerId.includes(",")) {
      throw new Error(
        "Field 'worker_id' must not contain commas (Notion select restriction).",
      );
    }
    if (workerId.length > MAX_SELECT_NAME_LENGTH) {
      throw new Error(
        `Field 'worker_id' exceeds Notion's ${MAX_SELECT_NAME_LENGTH}-character select limit.`,
      );
    }
  }

  let finishedAt: string | null = null;
  if (obj.finished_at !== undefined && obj.finished_at !== null) {
    if (typeof obj.finished_at !== "string") {
      throw new Error(
        "Field 'finished_at' must be a valid ISO-8601 date string.",
      );
    }
    const trimmed = obj.finished_at.trim();
    if (!isValidDateString(trimmed)) {
      throw new Error(
        "Field 'finished_at' must be a valid ISO-8601 date string.",
      );
    }
    finishedAt = trimmed;
  }

  let scheduledAt: string;
  if (obj.scheduled_at !== undefined && obj.scheduled_at !== null) {
    if (typeof obj.scheduled_at !== "string") {
      throw new Error(
        "Field 'scheduled_at' must be a valid ISO-8601 date string.",
      );
    }
    const trimmed = obj.scheduled_at.trim();
    if (!isValidDateString(trimmed)) {
      throw new Error(
        "Field 'scheduled_at' must be a valid ISO-8601 date string.",
      );
    }
    scheduledAt = trimmed;
  } else {
    scheduledAt = finishedAt ?? new Date().toISOString();
  }

  let args: string[] = [];
  if (obj.args !== undefined) {
    if (Array.isArray(obj.args)) {
      if (!obj.args.every((item) => typeof item === "string")) {
        throw new Error("Field 'args' array elements must all be strings.");
      }
      args = obj.args;
    } else if (typeof obj.args === "string") {
      args = parseStringArgs(obj.args);
    } else {
      throw new Error("Field 'args' must be an array of strings or a string.");
    }
  }
  if (args.join(" ").length > MAX_RICH_TEXT_LENGTH) {
    throw new Error(
      `Field 'args' exceeds Notion's ${MAX_RICH_TEXT_LENGTH}-character limit.`,
    );
  }

  let output = "";
  if (obj.output !== undefined && obj.output !== null) {
    if (typeof obj.output !== "string") {
      throw new Error("Field 'output' must be a string.");
    }
    output = obj.output;
  }

  let uid: string = crypto.randomUUID();
  if (obj.uid !== undefined) {
    if (typeof obj.uid !== "string" || obj.uid.trim() === "") {
      throw new Error("Field 'uid' must be a non-empty string.");
    }
    uid = obj.uid.trim();
    if (uid.length > MAX_RICH_TEXT_LENGTH) {
      throw new Error(
        `Field 'uid' exceeds Notion's ${MAX_RICH_TEXT_LENGTH}-character limit.`,
      );
    }
  }

  return {
    uid,
    name,
    script: scriptRaw,
    args,
    status,
    scheduled_at: scheduledAt,
    finished_at: finishedAt,
    worker_id: workerId,
    output,
  };
}

/**
 * Parse a JSON string containing either a single inbox entry object
 * or a non-empty array of inbox entry objects.
 */
export function parseInboxJson(text: string): InboxEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error("Inbox JSON array must not be empty.");
    }
    return parsed.map((item, idx) => {
      try {
        return parseInboxEntry(item);
      } catch (err) {
        throw new Error(
          `Entry[${idx}]: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  return [parseInboxEntry(parsed)];
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const nonce = crypto.randomUUID().slice(0, 8);
  const tmpPath = path.join(dir, `.${base}.${nonce}.tmp`);
  await Deno.writeTextFile(tmpPath, JSON.stringify(data, null, 2) + "\n");
  await Deno.rename(tmpPath, filePath);
}

/**
 * Atomically write a validated InboxEntry into the inbox directory.
 * Uses a `.tmp` file + rename so the daemon never reads a partially written file.
 */
export async function writeInboxEntry(
  entry: InboxEntry,
  inboxDir: string = DEFAULT_INBOX_DIR,
): Promise<string> {
  await Deno.mkdir(inboxDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeUid = entry.uid.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const nonce = crypto.randomUUID().slice(0, 8);
  const filename = `${ts}_${safeUid}_${nonce}.json`;
  const finalPath = path.join(inboxDir, filename);

  await atomicWriteJson(finalPath, entry);
  return finalPath;
}

async function moveToFailed(
  filePath: string,
  inboxDir: string,
  filename: string,
): Promise<void> {
  const failedDir = path.join(inboxDir, "failed");
  await Deno.mkdir(failedDir, { recursive: true });
  let destPath = path.join(failedDir, filename);
  try {
    await Deno.stat(destPath);
    const suffix = Date.now();
    destPath = path.join(failedDir, `${suffix}_${filename}`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }
  await Deno.rename(filePath, destPath);
}

export interface DrainInboxResult {
  processed: number;
  failed: number;
  retryLater: number;
}

/**
 * Drain all `.json` files in the inbox directory and push them to Notion.
 * - Valid entries pushed successfully are deleted.
 * - Invalid JSON / schema errors (or permanent HTTP 400 errors) are moved to `<inboxDir>/failed/`.
 * - Transient push errors leave remaining unpushed entries in place for retry without duplicating already-pushed entries.
 */
export async function drainInbox(
  config: AppConfig,
  pushFn: (entry: InboxEntry, config: AppConfig) => Promise<string> =
    createNotionInboxEntry,
  inboxDir: string = DEFAULT_INBOX_DIR,
): Promise<DrainInboxResult> {
  const result: DrainInboxResult = { processed: 0, failed: 0, retryLater: 0 };

  const files: string[] = [];
  try {
    for await (const dirEntry of Deno.readDir(inboxDir)) {
      if (
        dirEntry.isFile &&
        dirEntry.name.endsWith(".json") &&
        !dirEntry.name.startsWith(".")
      ) {
        files.push(dirEntry.name);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return result;
    }
    throw err;
  }

  files.sort();

  for (const filename of files) {
    const filePath = path.join(inboxDir, filename);
    let rawText: string;

    try {
      rawText = await Deno.readTextFile(filePath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        `Inbox file '${filename}' read failed (${msg}); will retry on next cycle`,
      );
      result.retryLater++;
      continue;
    }

    let entries: InboxEntry[];
    try {
      entries = parseInboxJson(rawText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        `Inbox file '${filename}' invalid (${msg}); moving to failed/`,
      );
      await moveToFailed(filePath, inboxDir, filename);
      result.failed++;
      continue;
    }

    let pushedCount = 0;
    let pushError: unknown = null;

    for (const entry of entries) {
      try {
        await pushFn(entry, config);
        pushedCount++;
        logger.info(
          `[${entry.uid}] ${entry.name} (${entry.worker_id}): ingested read-only entry (${entry.status})`,
        );
      } catch (err) {
        pushError = err;
        break;
      }
    }

    result.processed += pushedCount;

    if (pushError === null) {
      try {
        await Deno.remove(filePath);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          logger.error(
            `Inbox file '${filename}' pushed but failed to remove: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      continue;
    }

    const msg = pushError instanceof Error
      ? pushError.message
      : String(pushError);
    const remaining = entries.slice(pushedCount);

    if (pushedCount > 0) {
      // Rewrite file with only the unpushed entries so retries don't duplicate
      await atomicWriteJson(
        filePath,
        remaining.length === 1 ? remaining[0] : remaining,
      );
    }

    if (isPermanentNotionError(pushError)) {
      logger.error(
        `Inbox file '${filename}' rejected by Notion (${msg}); moving remaining entry(s) to failed/`,
      );
      await moveToFailed(filePath, inboxDir, filename);
      result.failed++;
    } else {
      logger.error(
        `Inbox file '${filename}' push failed (${msg}); will retry on next cycle`,
      );
      result.retryLater++;
    }
  }

  return result;
}
