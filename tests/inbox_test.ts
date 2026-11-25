import { assert, assertEquals, assertThrows } from "@std/assert";
import * as path from "@std/path";
import {
  drainInbox,
  type InboxEntry,
  parseInboxEntry,
  parseInboxJson,
  writeInboxEntry,
} from "../src/inbox.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

// ─── Validation Tests ───────────────────────────────────────────────

Deno.test("parseInboxEntry: accepts minimal valid entry with defaults", () => {
  const entry = parseInboxEntry({
    name: "systemd backup",
    status: "success",
  });

  assertEquals(entry.name, "systemd backup");
  assertEquals(entry.script, "");
  assertEquals(entry.args, []);
  assertEquals(entry.status, "success");
  assertEquals(entry.worker_id, "external");
  assertEquals(entry.finished_at, null);
  assertEquals(entry.output, "");
  assert(entry.uid.length > 0);
  assert(!Number.isNaN(new Date(entry.scheduled_at).getTime()));
});

Deno.test("parseInboxEntry: falls back to script when name is omitted", () => {
  const entry = parseInboxEntry({
    script: "backup.service",
    status: "failed",
    worker_id: "oracle-systemd",
    args: "--full --verify",
    scheduled_at: "2026-11-25T03:00:00Z",
    finished_at: "2026-11-25T03:01:00Z",
    output: "exit code 1",
    uid: "custom-uid-1",
  });

  assertEquals(entry.name, "backup.service");
  assertEquals(entry.script, "backup.service");
  assertEquals(entry.args, ["--full", "--verify"]);
  assertEquals(entry.status, "failed");
  assertEquals(entry.worker_id, "oracle-systemd");
  assertEquals(entry.scheduled_at, "2026-11-25T03:00:00Z");
  assertEquals(entry.finished_at, "2026-11-25T03:01:00Z");
  assertEquals(entry.output, "exit code 1");
  assertEquals(entry.uid, "custom-uid-1");
});

Deno.test("parseInboxEntry: defaults scheduled_at to finished_at if omitted", () => {
  const entry = parseInboxEntry({
    name: "cron job",
    status: "success",
    finished_at: "2026-11-25T04:00:00Z",
  });

  assertEquals(entry.scheduled_at, "2026-11-25T04:00:00Z");
  assertEquals(entry.finished_at, "2026-11-25T04:00:00Z");
});

Deno.test("parseInboxEntry: accepts bracketed TZ dates with surrounding whitespace", () => {
  const entry = parseInboxEntry({
    name: "tz job",
    status: "success",
    scheduled_at: " 2026-11-25T03:00:00-05:00[America/New_York] ",
    finished_at: null,
  });

  assertEquals(
    entry.scheduled_at,
    "2026-11-25T03:00:00-05:00[America/New_York]",
  );
  assertEquals(entry.finished_at, null);
});

Deno.test("parseInboxEntry: rejects non-terminal statuses", () => {
  for (const status of ["pending", "running", "disabled", "skipped", "other"]) {
    assertThrows(
      () => parseInboxEntry({ name: "job", status }),
      Error,
      "Invalid status",
    );
  }
});

Deno.test("parseInboxEntry: rejects missing name and script", () => {
  assertThrows(
    () => parseInboxEntry({ status: "success" }),
    Error,
    "At least one of 'name' or 'script'",
  );
  assertThrows(
    () => parseInboxEntry({ name: "   ", script: "", status: "success" }),
    Error,
    "At least one of 'name' or 'script'",
  );
});

Deno.test("parseInboxEntry: rejects non-ISO and invalid date strings", () => {
  for (
    const badDate of [
      "not-a-date",
      "2026",
      "Nov 25, 2026",
      "12/25/2026",
      "2026-11-25T03:00:00Z[Fake/Zone]",
    ]
  ) {
    assertThrows(
      () =>
        parseInboxEntry({
          name: "job",
          status: "success",
          scheduled_at: badDate,
        }),
      Error,
      "scheduled_at",
    );
  }
  assertThrows(
    () =>
      parseInboxEntry({
        name: "job",
        status: "success",
        finished_at: "Nov 25, 2026",
      }),
    Error,
    "finished_at",
  );
});

Deno.test("parseInboxEntry: validates worker_id, args, and field lengths", () => {
  assertThrows(
    () =>
      parseInboxEntry({
        name: "job",
        status: "success",
        worker_id: "oracle,systemd",
      }),
    Error,
    "commas",
  );
  assertThrows(
    () =>
      parseInboxEntry({
        name: "job",
        status: "success",
        worker_id: "x".repeat(101),
      }),
    Error,
    "100-character",
  );
  assertThrows(
    () =>
      parseInboxEntry({
        name: "job",
        status: "success",
        args: ["ok", 123],
      }),
    Error,
    "must all be strings",
  );
  assertThrows(
    () =>
      parseInboxEntry({
        name: "x".repeat(2001),
        status: "success",
      }),
    Error,
    "2000-character",
  );
});

Deno.test("parseInboxJson: supports single object and array", () => {
  const single = parseInboxJson(
    JSON.stringify({ name: "a", status: "success" }),
  );
  assertEquals(single.length, 1);
  assertEquals(single[0].name, "a");

  const batch = parseInboxJson(
    JSON.stringify([
      { name: "a", status: "success" },
      { name: "b", status: "missed" },
    ]),
  );
  assertEquals(batch.length, 2);
  assertEquals(batch[1].status, "missed");

  assertThrows(() => parseInboxJson("[]"), Error, "must not be empty");
  assertThrows(() => parseInboxJson("{bad"), Error, "Invalid JSON");
  assertThrows(
    () =>
      parseInboxJson(
        JSON.stringify([
          { name: "ok", status: "success" },
          { name: "bad", status: "pending" },
        ]),
      ),
    Error,
    "Entry[1]:",
  );
});

// ─── Drain & Atomic Write Tests ─────────────────────────────────────

Deno.test("drainInbox: returns zeros when inbox directory does not exist", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const missingDir = path.join(tmpDir, "nonexistent");
    const res = await drainInbox(
      DEFAULT_CONFIG,
      () => Promise.resolve("page-id"),
      missingDir,
    );
    assertEquals(res, { processed: 0, failed: 0, retryLater: 0 });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeInboxEntry: same-ms writes with identical uid do not collide", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const entry = parseInboxEntry({
      uid: "same-uid",
      name: "job",
      status: "success",
    });
    const [p1, p2] = await Promise.all([
      writeInboxEntry(entry, tmpDir),
      writeInboxEntry(entry, tmpDir),
    ]);
    assert(p1 !== p2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("writeInboxEntry + drainInbox: pushes valid entries and removes files", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const entry = parseInboxEntry({
      name: "watchtower",
      worker_id: "oracle-watchtower",
      status: "success",
      output: "Updated 1 container",
    });

    const writtenPath = await writeInboxEntry(entry, tmpDir);
    assert(writtenPath.endsWith(".json"));

    // Also drop a .tmp file that should be ignored
    await Deno.writeTextFile(path.join(tmpDir, ".partial.json.tmp"), "{");

    const pushed: InboxEntry[] = [];
    const res = await drainInbox(
      DEFAULT_CONFIG,
      (e) => {
        pushed.push(e);
        return Promise.resolve("page-1");
      },
      tmpDir,
    );

    assertEquals(res, { processed: 1, failed: 0, retryLater: 0 });
    assertEquals(pushed.length, 1);
    assertEquals(pushed[0].uid, entry.uid);
    assertEquals(pushed[0].worker_id, "oracle-watchtower");

    // Processed file should be removed; .tmp file untouched
    const remaining: string[] = [];
    for await (const f of Deno.readDir(tmpDir)) {
      remaining.push(f.name);
    }
    assertEquals(remaining.sort(), [".partial.json.tmp"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("drainInbox: moves invalid and HTTP 400 files to failed/, retries transient errors", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(path.join(tmpDir, "01_bad.json"), "{invalid json");
    await Deno.writeTextFile(
      path.join(tmpDir, "02_pending.json"),
      JSON.stringify({ name: "nope", status: "pending" }),
    );
    await Deno.writeTextFile(
      path.join(tmpDir, "03_notion400.json"),
      JSON.stringify({ name: "bad-400", status: "failed" }),
    );
    await Deno.writeTextFile(
      path.join(tmpDir, "04_retry.json"),
      JSON.stringify({ name: "transient", status: "failed" }),
    );

    const res = await drainInbox(
      DEFAULT_CONFIG,
      (entry) => {
        if (entry.name === "bad-400") {
          return Promise.reject(
            Object.assign(new Error("validation_error"), { status: 400 }),
          );
        }
        return Promise.reject(new Error("Notion 503"));
      },
      tmpDir,
    );

    assertEquals(res, { processed: 0, failed: 3, retryLater: 1 });

    // Invalid + 400 files moved to failed/
    const failedFiles: string[] = [];
    for await (const f of Deno.readDir(path.join(tmpDir, "failed"))) {
      failedFiles.push(f.name);
    }
    assertEquals(
      failedFiles.sort(),
      ["01_bad.json", "02_pending.json", "03_notion400.json"],
    );

    // Transient failure remains in inbox for next poll
    const remaining: string[] = [];
    for await (const f of Deno.readDir(tmpDir)) {
      if (f.isFile) remaining.push(f.name);
    }
    assertEquals(remaining, ["04_retry.json"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("drainInbox: partial batch failure rewrites only unpushed entries for retry", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      path.join(tmpDir, "batch.json"),
      JSON.stringify([
        { uid: "u1", name: "first", status: "success" },
        { uid: "u2", name: "second", status: "failed" },
        { uid: "u3", name: "third", status: "success" },
      ]),
    );

    const pushedUids: string[] = [];
    let failSecondOnce = true;

    const pushFn = (entry: InboxEntry) => {
      if (entry.uid === "u2" && failSecondOnce) {
        failSecondOnce = false;
        return Promise.reject(new Error("Notion 429"));
      }
      pushedUids.push(entry.uid);
      return Promise.resolve(`page-${entry.uid}`);
    };

    // First cycle: u1 succeeds, u2 fails transiently -> file rewritten with [u2, u3]
    const firstRes = await drainInbox(DEFAULT_CONFIG, pushFn, tmpDir);
    assertEquals(firstRes, { processed: 1, failed: 0, retryLater: 1 });
    assertEquals(pushedUids, ["u1"]);

    // Second cycle: only u2 and u3 are pushed; u1 is NOT duplicated
    const secondRes = await drainInbox(DEFAULT_CONFIG, pushFn, tmpDir);
    assertEquals(secondRes, { processed: 2, failed: 0, retryLater: 0 });
    assertEquals(pushedUids, ["u1", "u2", "u3"]);

    // File is now removed
    const remaining: string[] = [];
    for await (const f of Deno.readDir(tmpDir)) {
      remaining.push(f.name);
    }
    assertEquals(remaining, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
