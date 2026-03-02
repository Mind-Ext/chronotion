import { assertEquals, assertNotEquals } from "@std/assert";
import {
  addJob,
  createJob,
  findJob,
  generateUid,
  updateJob,
} from "./queue.ts";
import type { QueueData } from "./types.ts";

Deno.test("generateUid produces consistent 12-char hex", () => {
  const uid = generateUid("test.ts", ["arg1"], "2024-01-01T00:00:00Z");
  assertEquals(uid.length, 12);
  assertEquals(/^[0-9a-f]+$/.test(uid), true);
  // Same inputs produce same UID
  const uid2 = generateUid("test.ts", ["arg1"], "2024-01-01T00:00:00Z");
  assertEquals(uid, uid2);
});

Deno.test("generateUid differs for different inputs", () => {
  const uid1 = generateUid("a.ts", [], "2024-01-01T00:00:00Z");
  const uid2 = generateUid("b.ts", [], "2024-01-01T00:00:00Z");
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
  assertEquals(job.uid.length, 12);
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
