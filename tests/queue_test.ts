import { assertEquals, assertNotEquals } from "@std/assert";
import {
  addJob,
  createJob,
  findJob,
  generateUid,
  mergeWithNotion,
  updateJob,
} from "../src/queue.ts";
import type { JobInstance, QueueData } from "../src/types.ts";

/** Helper: create a minimal JobInstance with overrides */
function makeTestJob(overrides: Partial<JobInstance> = {}): JobInstance {
  return {
    uid: "test-uid",
    name: undefined,
    script: "test.ts",
    args: [],
    deno_args: [],
    run_at: "2025-01-01T00:00:00Z",
    next_in: "1d",
    status: "pending",
    end_on: null,
    prev_instance: null,
    next_instance: null,
    output: "",
    timeout_minutes: null,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

Deno.test("generateUid produces valid UUID v4", () => {
  const uid = generateUid();
  assertEquals(uid.length, 36);
  assertEquals(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(uid),
    true,
  );
});

Deno.test("generateUid produces unique values", () => {
  const uid1 = generateUid();
  const uid2 = generateUid();
  assertNotEquals(uid1, uid2);
});

Deno.test("createJob returns a complete JobInstance", () => {
  const job = createJob({
    script: "test.ts",
    args: [],
    run_at: "2024-06-01T12:00:00Z",
    next_in: "1d",
  });
  assertEquals(job.script, "test.ts");
  assertEquals(job.status, "pending");
  assertEquals(job.uid.length, 36);
  assertEquals(job.deno_args.length, 0);
  assertEquals(job.prev_instance, null);
});

Deno.test("findJob and updateJob work correctly", () => {
  const queue: QueueData = { jobs: [], last_updated: "" };
  const job = createJob({
    script: "test.ts",
    args: [],
    run_at: "2024-06-01T12:00:00Z",
    next_in: "1d",
  });
  addJob(queue, job);

  const found = findJob(queue, job.uid);
  assertEquals(found?.script, "test.ts");

  const updated = updateJob(queue, job.uid, { status: "running" });
  assertEquals(updated, true);
  assertEquals(queue.jobs[0].status, "running");

  const notFound = updateJob(queue, "nonexistent", { status: "failed" });
  assertEquals(notFound, false);
});

// ─── mergeWithNotion Tests ──────────────────────────────────────────

Deno.test("mergeWithNotion: running local job is not overwritten by remote pending", () => {
  const local: QueueData = {
    jobs: [
      makeTestJob({
        uid: "page-1",
        script: "sync.ts",
        status: "running",
        notion_page_id: "page-1",
      }),
    ],
    last_updated: "",
  };

  const remote = [
    makeTestJob({
      uid: "page-1",
      script: "sync.ts",
      status: "pending",
      notion_page_id: "page-1",
    }),
  ];

  const { queue: result } = mergeWithNotion(local, remote);
  const job = result.jobs.find((j) => j.notion_page_id === "page-1");
  assertEquals(job?.status, "running"); // Local running state preserved
});

Deno.test("mergeWithNotion: pending local job IS overwritten by remote", () => {
  const local: QueueData = {
    jobs: [
      makeTestJob({
        uid: "page-2",
        script: "sync.ts",
        status: "pending",
        notion_page_id: "page-2",
      }),
    ],
    last_updated: "",
  };

  const remote = [
    makeTestJob({
      uid: "page-2",
      script: "sync_updated.ts",
      status: "pending",
      notion_page_id: "page-2",
    }),
  ];

  const { queue: result } = mergeWithNotion(local, remote);
  const job = result.jobs.find((j) => j.notion_page_id === "page-2");
  assertEquals(job?.script, "sync_updated.ts"); // Remote definition wins
});

Deno.test("mergeWithNotion: new remote jobs are added", () => {
  const local: QueueData = {
    jobs: [],
    last_updated: "",
  };

  const remote = [
    makeTestJob({
      uid: "page-new",
      script: "new_job.ts",
      notion_page_id: "page-new",
    }),
  ];

  const { queue: result } = mergeWithNotion(local, remote);
  assertEquals(result.jobs.length, 1);
  assertEquals(result.jobs[0].script, "new_job.ts");
});

Deno.test("mergeWithNotion: purely local jobs (no page_id) are preserved", () => {
  const local: QueueData = {
    jobs: [
      makeTestJob({
        uid: "local-only",
        script: "local.ts",
        // No notion_page_id
      }),
    ],
    last_updated: "",
  };

  const remote = [
    makeTestJob({
      uid: "page-remote",
      script: "remote.ts",
      notion_page_id: "page-remote",
    }),
  ];

  const { queue: result } = mergeWithNotion(local, remote);
  assertEquals(result.jobs.length, 2);
  assertEquals(
    result.jobs.find((j) => j.uid === "local-only")?.script,
    "local.ts",
  );
  assertEquals(
    result.jobs.find((j) => j.notion_page_id === "page-remote")?.script,
    "remote.ts",
  );
});

Deno.test("mergeWithNotion: success/failed local jobs are protected", () => {
  const local: QueueData = {
    jobs: [
      makeTestJob({
        uid: "page-done",
        status: "success",
        output: "completed!",
        notion_page_id: "page-done",
      }),
    ],
    last_updated: "",
  };

  const remote = [
    makeTestJob({
      uid: "page-done",
      status: "pending",
      output: "",
      notion_page_id: "page-done",
    }),
  ];

  const { queue: result } = mergeWithNotion(local, remote);
  const job = result.jobs.find((j) => j.notion_page_id === "page-done");
  assertEquals(job?.status, "success"); // Not overwritten
  assertEquals(job?.output, "completed!"); // Output preserved
});
