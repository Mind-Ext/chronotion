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
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.d.ts";
import type { AppConfig, JobInstance, JobStatus } from "./types.ts";
import { JOB_STATUSES } from "./types.ts";
import {
  buildTitle,
  getDateString,
  getNumberValue,
  getPlainText,
  getRelationId,
  getSelectValue,
  parseStringArgs,
  REQUIRED_PROPERTIES,
  richText,
  truncateOutput,
  validateNotionEnvVars,
} from "./notion_utils.ts";

// ─── Client Initialization ──────────────────────────────────────────

let _client: Client | null = null;

/** Get or create the Notion client (singleton). */
export function getClient(): Client {
  if (!_client) {
    const { apiKey } = validateNotionEnvVars();
    _client = new Client({ auth: apiKey });
  }
  return _client;
}

/** Get the database ID from env. */
export function getDatabaseId(): string {
  const { databaseId } = validateNotionEnvVars();
  return databaseId;
}

/** Reset client (for testing). */
export function resetClient(): void {
  _client = null;
}

// ─── Database Schema Provisioning ───────────────────────────────────

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

// ─── Property Helpers (Re-exported for convenience or internal use) ──

export { truncateOutput };

// ─── Pull Logic ─────────────────────────────────────────────────────

export interface FetchedJob extends JobInstance {
  /** True if the Notion page had an empty status field when pulled */
  _notion_status_is_null: boolean;
}

/** Convert a Notion page to a FetchedJob. */
function pageToJob(page: PageObjectResponse): FetchedJob {
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
  const uid = getPlainText(props.uid);
  const prevInstance = getRelationId(props.prev_instance);
  const nextInstance = getRelationId(props.next_instance);
  const timeoutMinutes = getNumberValue(props.timeout_minutes);

  const statusIsNull = !status || !JOB_STATUSES.includes(status as JobStatus);

  return {
    uid: uid || crypto.randomUUID(), // Prefer Notion-stored UID, fallback to new one if missing
    name: name || undefined,
    script,
    args: parseStringArgs(argsRaw),
    deno_args: parseStringArgs(denoArgsRaw),
    run_at: runAt ?? new Date().toISOString(),
    next_in: nextIn || "never",
    status: statusIsNull ? "pending" : (status as JobStatus),
    end_on: endOn,
    prev_instance: prevInstance,
    next_instance: nextInstance,
    output: output,
    notion_page_id: page.id,
    timeout_minutes: timeoutMinutes,
    created_at: page.created_time ?? new Date().toISOString(),
    _notion_status_is_null: statusIsNull,
  };
}

/**
 * Fetch all jobs from the Notion database.
 * Uses pagination to handle large databases.
 */
export async function fetchJobs(
  databaseId?: string,
): Promise<FetchedJob[]> {
  const notion = getClient();
  const dbId = databaseId ?? getDatabaseId();
  const jobs: FetchedJob[] = [];

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
    uid: { rich_text: richText(job.uid) },
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
export async function createNextNotionInstance(
  job: JobInstance,
  nextRunAt: string,
  config: AppConfig,
  nextUid: string,
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
    uid: { rich_text: richText(nextUid) },
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
