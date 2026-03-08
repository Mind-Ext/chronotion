/**
 * Notion Sync Engine for Chronotion.
 *
 * Handles all communication with the Notion API:
 * - Client initialization
 * - Database schema provisioning
 * - Pull: fetching jobs from Notion → JobInstance[]
 * - Push: patching Notion pages with status/output
 * - Reschedule: creating new Notion pages for recurring jobs
 */

import { Client, isFullDatabase } from "@notionhq/client";
import type {
  DatabaseObjectResponse as _DatabaseObjectResponse,
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.d.ts";
import type { AppConfig, JobInstance, JobStatus } from "./types.ts";
import { JOB_STATUSES } from "./types.ts";

// ─── Output Truncation ───────────────────────────────────────────────

const MAX_RICH_TEXT_LENGTH = 2000;
const TRUNCATION_TARGET = 1950;

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
function parseStringArgs(raw: string): string[] {
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

// ─── Client Initialization ──────────────────────────────────────────

let _client: Client | null = null;

/** Get or create the Notion client (singleton). */
export function getClient(): Client {
  if (!_client) {
    const auth = Deno.env.get("NOTION_API_KEY");
    if (!auth) {
      throw new Error(
        "NOTION_API_KEY environment variable is required when local_mode is false",
      );
    }
    _client = new Client({ auth });
  }
  return _client;
}

/** Get the database ID from env. */
export function getDatabaseId(): string {
  const id = Deno.env.get("NOTION_DB_ID") ||
    Deno.env.get("NOTION_DATABASE_ID") ||
    Deno.env.get("NOTION_TEST_DATABASE_ID");
  if (!id) {
    throw new Error(
      "NOTION_DB_ID environment variable is required when local_mode is false",
    );
  }
  return id;
}

/** Reset client (for testing). */
export function resetClient(): void {
  _client = null;
}

// ─── Database Schema Provisioning ───────────────────────────────────

const STATUS_COLORS: Record<JobStatus, string> = {
  pending: "purple",
  running: "blue",
  success: "green",
  failed: "red",
  error: "orange",
  disabled: "brown",
  skipped: "gray",
};

/** Required properties and their Notion types. */
const REQUIRED_PROPERTIES: Record<string, object> = {
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
  output: { rich_text: {} },
  prev_instance: { relation: { database_id: "SELF", single_property: {} } },
  next_instance: { relation: { database_id: "SELF", single_property: {} } },
  timeout_minutes: { number: { format: "number" } },
};

/**
 * Ensure the database has all required properties.
 * This adds missing properties but never removes existing ones.
 */
export async function initDatabaseSchema(
  databaseId?: string,
): Promise<void> {
  const notion = getClient();
  const dbId = databaseId ?? getDatabaseId();

  // Retrieve current schema
  const db = await notion.databases.retrieve({ database_id: dbId });
  if (!isFullDatabase(db)) {
    throw new Error("Database not found or not shared with integration");
  }

  const existingProps = new Set(Object.keys(db.properties));

  // Rename title property to "name" if it has a different name
  const titlePropName = Object.entries(db.properties).find(
    ([_, schema]) => schema.type === "title",
  )?.[0];

  if (titlePropName && titlePropName !== "name") {
    await notion.databases.update({
      database_id: dbId,
      properties: {
        [titlePropName]: { name: "name" },
      },
    });
    existingProps.delete(titlePropName);
    existingProps.add("name");
  }

  // Build update payload for missing properties
  // deno-lint-ignore no-explicit-any
  const toAdd: Record<string, any> = {};
  for (const [name, schema] of Object.entries(REQUIRED_PROPERTIES)) {
    // Skip title — can't be added, it already exists under some name
    if ("title" in schema) continue;

    if (!existingProps.has(name)) {
      const propSchema = { ...schema };
      // Fix self-referencing relations
      if (
        "relation" in propSchema &&
        // deno-lint-ignore no-explicit-any
        (propSchema as any).relation?.database_id === "SELF"
      ) {
        // deno-lint-ignore no-explicit-any
        (propSchema as any).relation.database_id = dbId;
      }
      toAdd[name] = propSchema;
    }
  }

  if (Object.keys(toAdd).length > 0) {
    await notion.databases.update({
      database_id: dbId,
      properties: toAdd,
    });
  }
}

// ─── Property Helpers ───────────────────────────────────────────────

type NotionPage = PageObjectResponse;

/** Safely extract plain text from a Notion rich_text or title array. */
function getPlainText(
  prop: {
    type: "rich_text" | "title";
    rich_text?: Array<{ plain_text: string }>;
    title?: Array<{ plain_text: string }>;
  } | undefined,
): string {
  if (!prop) return "";
  const arr = prop.type === "title" ? prop.title : prop.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((t) => t.plain_text).join("");
}

/** Safely extract a date string from a Notion date property. */
function getDateString(
  prop: { type: "date"; date: { start: string } | null } | undefined,
): string | null {
  const start = prop?.date?.start;
  if (!start) return null;
  return new Date(start).toISOString();
}

/** Safely extract a select value. */
function getSelectValue(
  prop: { type: "select"; select: { name: string } | null } | undefined,
): string | null {
  return prop?.select?.name ?? null;
}

/** Safely extract a number value. */
function getNumberValue(
  prop: { type: "number"; number: number | null } | undefined,
): number | null {
  return prop?.number ?? null;
}

/** Safely extract the first relation page ID. */
function getRelationId(
  prop: { type: "relation"; relation: Array<{ id: string }> } | undefined,
): string | null {
  if (!prop?.relation || !Array.isArray(prop.relation)) return null;
  return prop.relation[0]?.id ?? null;
}

// ─── Pull Logic ─────────────────────────────────────────────────────

/** Convert a Notion page to a JobInstance. */
function pageToJob(page: NotionPage): JobInstance {
  // deno-lint-ignore no-explicit-any
  const props = page.properties as Record<string, any>;

  const name = getPlainText(props.name);
  const script = getPlainText(props.script);
  const argsRaw = getPlainText(props.args);
  const denoArgsRaw = getPlainText(props.deno_args);
  const runAt = getDateString(props.run_at);
  const nextIn = getPlainText(props.next_in);
  const endOn = getDateString(props.end_on);
  const status = getSelectValue(props.status) as JobStatus | null;
  const output = getPlainText(props.output);
  const prevInstance = getRelationId(props.prev_instance);
  const nextInstance = getRelationId(props.next_instance);
  const timeoutMinutes = getNumberValue(props.timeout_minutes);

  return {
    uid: page.id, // Use Notion page ID as uid for remote jobs
    name: name || undefined,
    script,
    args: parseStringArgs(argsRaw),
    deno_args: parseStringArgs(denoArgsRaw),
    run_at: runAt ?? new Date().toISOString(),
    next_in: nextIn || "never",
    status: (status && JOB_STATUSES.includes(status as JobStatus))
      ? status as JobStatus
      : "pending",
    end_on: endOn,
    prev_instance: prevInstance,
    next_instance: nextInstance,
    output,
    notion_page_id: page.id,
    timeout_minutes: timeoutMinutes,
    created_at: page.created_time ?? new Date().toISOString(),
  };
}

/**
 * Fetch all jobs from the Notion database.
 * Uses pagination to handle large databases.
 */
export async function fetchJobs(
  databaseId?: string,
): Promise<JobInstance[]> {
  const notion = getClient();
  const dbId = databaseId ?? getDatabaseId();
  const jobs: JobInstance[] = [];

  let hasMore = true;
  let startCursor: string | undefined = undefined;

  while (hasMore) {
    // deno-lint-ignore no-explicit-any
    const response: any = await notion.databases.query({
      database_id: dbId,
      start_cursor: startCursor,
    });

    for (const page of response.results) {
      jobs.push(pageToJob(page));
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return jobs;
}

// ─── Push Logic ─────────────────────────────────────────────────────

/**
 * Build the Notion title with emoji prefix.
 * E.g., "✅ sync.ts" or "⏳ backup.sh"
 */
function buildTitle(
  script: string,
  status: JobStatus,
  config: AppConfig,
): string {
  const emoji = config.emojis[status] ?? "";
  return emoji ? `${emoji} ${script}` : script;
}

/** Build a rich_text array from a plain string. */
function richText(
  text: string,
): Array<{ type: "text"; text: { content: string } }> {
  if (!text) return [];
  return [{ type: "text", text: { content: text } }];
}

/**
 * Update a Notion page with job status, output, and emoji title.
 */
export async function updateNotionJob(
  job: JobInstance,
  config: AppConfig,
): Promise<void> {
  if (!job.notion_page_id) return;

  const notion = getClient();
  const truncatedOutput = truncateOutput(job.output);

  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {
    name: {
      title: richText(buildTitle(job.name || job.script, job.status, config)),
    },
    script: { rich_text: richText(job.script) },
    status: { select: { name: job.status } },
    output: { rich_text: richText(truncatedOutput) },
  };

  // Update next_instance if set
  if (job.next_instance) {
    properties.next_instance = {
      relation: [{ id: job.next_instance }],
    };
  }

  await notion.pages.update({
    page_id: job.notion_page_id,
    properties,
  });
}

// ─── Reschedule Logic ───────────────────────────────────────────────

/**
 * Create a new Notion page for the next instance of a recurring job.
 * Links prev_instance to the original job's page.
 * Returns the new page ID.
 */
export async function createNextInstance(
  job: JobInstance,
  nextRunAt: string,
  config: AppConfig,
  databaseId?: string,
): Promise<string> {
  const notion = getClient();
  const dbId = databaseId ?? getDatabaseId();

  const title = buildTitle(job.name || job.script, "pending", config);

  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {
    name: { title: richText(title) },
    script: { rich_text: richText(job.script) },
    args: { rich_text: richText(job.args.join(" ")) },
    deno_args: { rich_text: richText(job.deno_args.join(" ")) },
    run_at: { date: { start: nextRunAt } },
    next_in: { rich_text: richText(job.next_in) },
    status: { select: { name: "pending" } },
    output: { rich_text: [] },
  };

  if (job.end_on) {
    properties.end_on = { date: { start: job.end_on } };
  }

  if (job.timeout_minutes !== null) {
    properties.timeout_minutes = { number: job.timeout_minutes };
  }

  // Link to previous instance
  if (job.notion_page_id) {
    properties.prev_instance = {
      relation: [{ id: job.notion_page_id }],
    };
  }

  const response = await notion.pages.create({
    parent: { database_id: dbId },
    properties,
  });

  const newPageId = response.id;

  // Update the original job to point forward
  if (job.notion_page_id) {
    await notion.pages.update({
      page_id: job.notion_page_id,
      properties: {
        next_instance: { relation: [{ id: newPageId }] },
      },
    });
  }

  return newPageId;
}
