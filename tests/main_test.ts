import { assertEquals } from "@std/assert";
import { findDueJobs, markOrphanedRunningJobsAsError } from "../src/main.ts";
import type { JobInstance, QueueData } from "../src/types.ts";

function makeJob(overrides: Partial<JobInstance> = {}): JobInstance {
  return {
    uid: "test123",
    script: "dummy.ts",
    args: [],
    deno_args: [],
    run_at: new Date(Date.now() - 60000).toISOString(), // 1 min ago
    next_in: "1d",
    status: "pending",
    end_on: null,
    prev_instance: null,
    next_instance: null,
    output: "",
    timeout_minutes: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

Deno.test("markOrphanedRunningJobsAsError marks unlocked running jobs as error", () => {
  const queue: QueueData = {
    jobs: [
      makeJob({ uid: "a", status: "running" }),
      makeJob({ uid: "b", status: "pending" }),
      makeJob({ uid: "c", status: "running" }),
    ],
    last_updated: "",
  };

  const recovered = markOrphanedRunningJobsAsError(queue);
  assertEquals(recovered.length, 2);
  assertEquals(queue.jobs[0].status, "error");
  assertEquals(
    queue.jobs[0].output,
    "Orchestrator interrupted: job was left in running state",
  );
  assertEquals(queue.jobs[1].status, "pending");
  assertEquals(queue.jobs[2].status, "error");
});

Deno.test("markOrphanedRunningJobsAsError marks only unlocked running jobs", () => {
  const queue: QueueData = {
    jobs: [
      makeJob({ uid: "orphan", status: "running" }),
      makeJob({ uid: "active", status: "running" }),
      makeJob({ uid: "pending", status: "pending" }),
    ],
    last_updated: "",
  };

  const recovered = markOrphanedRunningJobsAsError(
    queue,
    new Map([["active", Promise.resolve()]]),
  );

  assertEquals(recovered.length, 1);
  assertEquals(queue.jobs[0].status, "error");
  assertEquals(
    queue.jobs[0].output,
    "Orchestrator interrupted: job was left in running state",
  );
  assertEquals(queue.jobs[1].status, "running");
  assertEquals(queue.jobs[2].status, "pending");
});

Deno.test("markOrphanedRunningJobsAsError ignores running jobs with active tasks", () => {
  const queue: QueueData = {
    jobs: [
      makeJob({ uid: "active", status: "running" }),
    ],
    last_updated: "",
  };

  const recovered = markOrphanedRunningJobsAsError(
    queue,
    new Map([["active", Promise.resolve()]]),
  );

  assertEquals(recovered.length, 0);
  assertEquals(queue.jobs[0].status, "running");
});

Deno.test("findDueJobs finds overdue pending jobs", () => {
  const queue: QueueData = {
    jobs: [
      makeJob({ uid: "due", status: "pending" }),
      makeJob({
        uid: "future",
        status: "pending",
        run_at: "2099-01-01T00:00:00Z",
      }),
      makeJob({ uid: "done", status: "success" }),
      makeJob({ uid: "disabled", status: "disabled" }),
    ],
    last_updated: "",
  };

  const due = findDueJobs(queue);
  assertEquals(due.length, 1);
  assertEquals(due[0].uid, "due");
});

Deno.test("findDueJobs returns empty for no due jobs", () => {
  const queue: QueueData = {
    jobs: [
      makeJob({
        uid: "future",
        status: "pending",
        run_at: "2099-01-01T00:00:00Z",
      }),
    ],
    last_updated: "",
  };

  const due = findDueJobs(queue);
  assertEquals(due.length, 0);
});
