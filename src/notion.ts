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
  CreatePageParameters,
  PageObjectResponse,
  UpdatePageParameters,
} from "@notionhq/client/build/src/api-endpoints.d.ts";
import type { AppConfig, JobInstance, JobStatus } from "./types.ts";
import { JOB_STATUSES } from "./types.ts";
import {
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

/** Convert a Notion page to a JobInstance. */
function pageToJob(page: PageObjectResponse): JobInstance {
  // deno-lint-ignore no-explicit-any
  const props = page.properties as Record<string, any>;

  const name = getPlainText(props.name);
  const script = getPlainText(props.script);
  const argsRaw = getPlainText(props.args);
  const denoArgsRaw = getPlainText(props.deno_args);
  const runAt = getDateString(props.run_at);
  const nextIn = getPlainText(props.next_in);
  const endOn = getDateString(props.end_on);
  const statusRaw = getSelectValue(props.status);
  const uid = getPlainText(props.uid);
  const prevInstance = getRelationId(props.prev_instance);
  const nextInstance = getRelationId(props.next_instance);
  const timeoutMinutes = getNumberValue(props.timeout_minutes);

  const status = JOB_STATUSES.find((s) => s === statusRaw) ?? null;

  return {
    uid: uid || crypto.randomUUID(), // Prefer Notion-stored UID, fallback to new one if missing
    name: name || undefined,
    script,
    args: parseStringArgs(argsRaw),
    deno_args: parseStringArgs(denoArgsRaw),
    run_at: runAt ?? "",
    next_in: nextIn ?? "",
    status: status,
    end_on: endOn,
    prev_instance: prevInstance,
    next_instance: nextInstance,
    output: "", // Output is now stored as page content; not fetched during bulk pull for performance
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
 * Update a Notion page with job status and emoji title.
 * Output is appended as page content (blocks).
 */
export async function updateNotionJob(
  job: JobInstance,
  config: AppConfig,
): Promise<void> {
  if (!job.notion_page_id) return;

  const notion = getClient();

  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {
    name: {
      title: richText(job.name || job.script),
    },
    script: { rich_text: richText(job.script) },
    status: { select: job.status ? { name: job.status } : null },
    uid: { rich_text: richText(job.uid) },
  };

  const updatePayload: UpdatePageParameters = {
    page_id: job.notion_page_id,
    properties,
    ...(job.status && config.emojis[job.status] && {
      // deno-lint-ignore no-explicit-any
      icon: { type: "emoji", emoji: config.emojis[job.status] as any },
    }),
  };

  // 1. Update page properties and icon
  await notion.pages.update(updatePayload);

  // 2. Append output as a code block if job is finished and has output
  const terminalStatuses: (JobStatus)[] = [
    "success",
    "failed",
    "error",
    "missed",
  ];
  if (job.output && terminalStatuses.includes(job.status)) {
    const truncatedOutput = truncateOutput(job.output);
    await notion.blocks.children.append({
      block_id: job.notion_page_id,
      children: [
        {
          object: "block",
          type: "code",
          code: {
            rich_text: richText(truncatedOutput),
            language: "plain text",
          },
        },
      ],
    });
  }
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

  // deno-lint-ignore no-explicit-any
  const properties: Record<string, any> = {
    name: { title: richText(job.name || job.script) },
    script: { rich_text: richText(job.script) },
    args: { rich_text: richText(job.args.join(" ")) },
    deno_args: { rich_text: richText(job.deno_args.join(" ")) },
    run_at: { date: { start: nextRunAt } },
    next_in: { rich_text: richText(job.next_in) },
    status: { select: { name: "pending" } },
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

  const createPayload: CreatePageParameters = {
    parent: { database_id: dbId },
    properties,
    ...(config.emojis["pending"] && {
      // deno-lint-ignore no-explicit-any
      icon: { type: "emoji", emoji: config.emojis["pending"] as any },
    }),
  };

  const response = await notion.pages.create(createPayload);

  const newPageId = response.id;

  // Update the original job to point forward
  if (job.notion_page_id) {
    const forwardUpdatePayload: UpdatePageParameters = {
      page_id: job.notion_page_id,
      properties: {
        next_instance: { relation: [{ id: newPageId }] },
      },
    };
    await notion.pages.update(forwardUpdatePayload);
  }

  return newPageId;
}
