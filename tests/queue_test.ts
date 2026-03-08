import { assertEquals, assertNotEquals } from "@std/assert";
import {
  addJob,
  createJob,
  findJob,
  generateUid,
  updateJob,
} from "../src/queue.ts";
import type { QueueData } from "../src/types.ts";

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
