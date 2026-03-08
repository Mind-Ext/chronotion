/**
 * Integration tests for the Notion sync engine.
 *
 * These tests run against a REAL Notion test database configured via .env:
 *   NOTION_API_KEY, NOTION_TEST_DATABASE_ID
 *
 * The test database should be empty or a dedicated test database.
 */

import { assertEquals, assertExists } from "@std/assert";
import { assert } from "@std/assert";
import {
  createNextInstance,
  fetchJobs,
  getClient,
  getDatabaseId,
  initDatabaseSchema,
  resetClient,
  truncateOutput,
  updateNotionJob,
} from "../src/notion.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AppConfig, JobInstance } from "../src/types.ts";
import "@std/dotenv/load";

// ─── Test Config ────────────────────────────────────────────────────

const testConfig: AppConfig = {
  ...DEFAULT_CONFIG,
  local_mode: false,
};

// ─── Truncation Tests (pure, no API calls) ──────────────────────────

Deno.test("truncateOutput: short strings pass through unchanged", () => {
  const input = "Hello, world!";
  assertEquals(truncateOutput(input), input);
});

Deno.test("truncateOutput: exactly 2000 chars pass through", () => {
  const input = "x".repeat(2000);
  assertEquals(truncateOutput(input), input);
});

Deno.test("truncateOutput: 2001 chars get truncated", () => {
  const input = "a".repeat(2001);
  const result = truncateOutput(input);
  assert(result.length <= 2000);
  assert(result.startsWith("[..."));
  assert(result.includes("characters truncated"));
});

Deno.test("truncateOutput: large output keeps last 1950 chars", () => {
  const prefix = "A".repeat(5000);
  const suffix = "B".repeat(1950);
  const input = prefix + suffix;
  const result = truncateOutput(input);
  // The result should end with all the B's
  assert(result.endsWith(suffix));
  assert(result.length <= 2000);
});

Deno.test("truncateOutput: truncation marker shows correct count", () => {
  const input = "x".repeat(3000);
  const result = truncateOutput(input);
  // skipped = 3000 - 1950 = 1050
  assert(result.includes("1050 characters truncated"));
});

// ─── Integration Tests (require real Notion API) ────────────────────

/** Helper: clean up test pages from the database */
async function cleanupTestPages(dbId: string): Promise<void> {
  const notion = getClient();
  // deno-lint-ignore no-explicit-any
  const response: any = await notion.databases.query({
    database_id: dbId,
  });
  for (const page of response.results) {
    await notion.pages.update({
      page_id: page.id,
      archived: true,
    });
  }
}

Deno.test({
  name: "initDatabaseSchema: provisions required properties",
  async fn() {
    const dbId = getDatabaseId();
    resetClient();

    await initDatabaseSchema(dbId);

    // Verify by retrieving the database schema
    const notion = getClient();
    // deno-lint-ignore no-explicit-any
    const db: any = await notion.databases.retrieve({ database_id: dbId });
    const propNames = Object.keys(db.properties);

    // Check that our required properties exist
    const expectedProps = [
      "args",
      "deno_args",
      "run_at",
      "next_in",
      "end_on",
      "status",
      "output",
      "prev_instance",
      "next_instance",
      "timeout_minutes",
    ];

    for (const prop of expectedProps) {
      assert(
        propNames.includes(prop),
        `Missing property: ${prop}. Found: ${propNames.join(", ")}`,
      );
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "pull/push lifecycle: create, fetch, update, verify",
  async fn() {
    const dbId = getDatabaseId();
    resetClient();

    // Clean up any previous test data
    await cleanupTestPages(dbId);

    // Create a test page
    const notion = getClient();
    const testPage = await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        name: {
          title: [{ type: "text" as const, text: { content: "test_job.ts" } }],
        },
        script: {
          rich_text: [{
            type: "text" as const,
            text: { content: "test_job.ts" },
          }],
        },
        args: {
          rich_text: [
            { type: "text" as const, text: { content: '["--verbose"]' } },
          ],
        },
        run_at: { date: { start: "2025-01-15T10:00:00.000Z" } },
        next_in: {
          rich_text: [{ type: "text" as const, text: { content: "1d" } }],
        },
        status: { select: { name: "pending" } },
      },
    });

    assertExists(testPage.id);

    // Fetch jobs and verify the page was pulled correctly
    const jobs = await fetchJobs(dbId);
    assert(jobs.length >= 1, `Expected at least 1 job, got ${jobs.length}`);

    const pulled = jobs.find((j) => j.notion_page_id === testPage.id);
    assertExists(pulled, "Test page not found in fetched jobs");
    assertEquals(pulled.script, "test_job.ts");
    assertEquals(pulled.args, ["--verbose"]);
    assertEquals(pulled.status, "pending");
    assertEquals(pulled.next_in, "1d");

    // Push an update (mark as running)
    const updatedJob: JobInstance = {
      ...pulled,
      status: "running",
      output: "Executing...",
    };
    await updateNotionJob(updatedJob, testConfig);

    // Fetch again and verify the update
    const jobsAfter = await fetchJobs(dbId);
    const updated = jobsAfter.find((j) => j.notion_page_id === testPage.id);
    assertExists(updated, "Updated page not found");
    assertEquals(updated.status, "running");

    // Clean up
    await cleanupTestPages(dbId);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "createNextInstance: creates linked next job in Notion",
  async fn() {
    const dbId = getDatabaseId();
    resetClient();

    // Clean up
    await cleanupTestPages(dbId);

    // Create the original job
    const notion = getClient();
    const origPage = await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        name: {
          title: [
            { type: "text" as const, text: { content: "recurring.ts" } },
          ],
        },
        script: {
          rich_text: [
            { type: "text" as const, text: { content: "recurring.ts" } },
          ],
        },
        args: {
          rich_text: [{ type: "text" as const, text: { content: "[]" } }],
        },
        run_at: { date: { start: "2025-03-01T08:00:00.000Z" } },
        next_in: {
          rich_text: [{ type: "text" as const, text: { content: "1w" } }],
        },
        status: { select: { name: "success" } },
      },
    });

    const job: JobInstance = {
      uid: origPage.id,
      script: "recurring.ts",
      args: [],
      deno_args: [],
      run_at: "2025-03-01T08:00:00.000Z",
      next_in: "1w",
      status: "success",
      end_on: null,
      prev_instance: null,
      next_instance: null,
      output: "done",
      notion_page_id: origPage.id,
      timeout_minutes: null,
      created_at: new Date().toISOString(),
    };

    // Create next instance
    const nextPageId = await createNextInstance(
      job,
      "2025-03-08T08:00:00.000Z",
      testConfig,
      dbId,
    );

    assertExists(nextPageId);

    // Verify the next instance was created
    const jobs = await fetchJobs(dbId);
    const nextJob = jobs.find((j) => j.notion_page_id === nextPageId);
    assertExists(nextJob, "Next instance not found in database");
    assertEquals(nextJob.status, "pending");
    assertEquals(nextJob.run_at, "2025-03-08T08:00:00.000Z");

    // Verify prev_instance is linked
    assertEquals(nextJob.prev_instance, origPage.id);

    // Verify original job's next_instance is set
    const origJob = jobs.find((j) => j.notion_page_id === origPage.id);
    assertExists(origJob, "Original job not found");
    assertEquals(origJob.next_instance, nextPageId);

    // Clean up
    await cleanupTestPages(dbId);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

Deno.test({
  name: "date parsing: ISO-8601 dates from Notion are handled correctly",
  async fn() {
    const dbId = getDatabaseId();
    resetClient();
    await cleanupTestPages(dbId);

    const notion = getClient();
    // Create a page with a specific date
    const page = await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        name: {
          title: [
            { type: "text" as const, text: { content: "date_test.ts" } },
          ],
        },
        script: {
          rich_text: [
            { type: "text" as const, text: { content: "date_test.ts" } },
          ],
        },
        run_at: { date: { start: "2025-06-15T14:30:00.000Z" } },
        end_on: { date: { start: "2025-12-31T23:59:00.000Z" } },
        next_in: {
          rich_text: [{ type: "text" as const, text: { content: "1m" } }],
        },
        status: { select: { name: "pending" } },
      },
    });

    const jobs = await fetchJobs(dbId);
    const job = jobs.find((j) => j.notion_page_id === page.id);
    assertExists(job);

    // Verify dates are preserved as ISO strings
    assertEquals(job.run_at, "2025-06-15T14:30:00.000Z");
    assertEquals(job.end_on, "2025-12-31T23:59:00.000Z");

    // Verify Date objects can be created from the strings
    const runAt = new Date(job.run_at);
    assertEquals(runAt.getUTCFullYear(), 2025);
    assertEquals(runAt.getUTCMonth(), 5); // June = 5 (0-indexed)
    assertEquals(runAt.getUTCDate(), 15);

    await cleanupTestPages(dbId);
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
