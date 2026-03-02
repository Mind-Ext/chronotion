import { assertEquals } from "@std/assert";
import {
  buildCommand,
  detectRuntime,
  sanitizeDenoArgs,
  validateScriptPath,
} from "./executor.ts";
import type { JobInstance } from "./types.ts";

// --- Runtime detection ---

Deno.test("detectRuntime: typescript", () => {
  assertEquals(detectRuntime("sync.ts"), "deno");
});

Deno.test("detectRuntime: javascript", () => {
  assertEquals(detectRuntime("sync.js"), "deno");
});

Deno.test("detectRuntime: python", () => {
  assertEquals(detectRuntime("clean.py"), "uv");
});

Deno.test("detectRuntime: bash", () => {
  assertEquals(detectRuntime("backup.sh"), "bash");
});

Deno.test("detectRuntime: unknown", () => {
  assertEquals(detectRuntime("file.xyz"), null);
});

// --- Path jail ---

Deno.test("validateScriptPath: valid path", () => {
  const result = validateScriptPath("sync.ts", "/home/user/project/scripts");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.resolved, "/home/user/project/scripts/sync.ts");
  }
});

Deno.test("validateScriptPath: subdirectory is allowed", () => {
  const result = validateScriptPath(
    "utils/helper.ts",
    "/home/user/project/scripts",
  );
  assertEquals(result.ok, true);
});

Deno.test("validateScriptPath: traversal blocked", () => {
  const result = validateScriptPath(
    "../secret.ts",
    "/home/user/project/scripts",
  );
  assertEquals(result.ok, false);
});

Deno.test("validateScriptPath: absolute path blocked", () => {
  const result = validateScriptPath(
    "/etc/passwd",
    "/home/user/project/scripts",
  );
  assertEquals(result.ok, false);
});

// --- Deno args sanitization ---

Deno.test("sanitizeDenoArgs: allows permission flags", () => {
  const result = sanitizeDenoArgs([
    "--allow-read",
    "--allow-net",
    "--deny-write",
    "--unstable",
  ]);
  assertEquals(result.length, 4);
});

Deno.test("sanitizeDenoArgs: blocks dangerous flags", () => {
  const result = sanitizeDenoArgs(["--eval", "-A", "--import-map=foo"]);
  assertEquals(result.length, 0);
});

// --- Command building ---

function makeJob(overrides: Partial<JobInstance> = {}): JobInstance {
  return {
    uid: "test123",
    script: "test.ts",
    args: [],
    deno_args: [],
    run_at: "2024-06-01T12:00:00Z",
    next_in: "1d",
    status: "pending",
    prev_instance: null,
    output: "",
    timeout_minutes: null,
    created_at: "2024-06-01T00:00:00Z",
    ...overrides,
  };
}

Deno.test("buildCommand: deno with no args", () => {
  const job = makeJob();
  const cmd = buildCommand(job, "/scripts/test.ts", "deno");
  assertEquals(cmd, ["deno", "run", "/scripts/test.ts"]);
});

Deno.test("buildCommand: deno with args and permissions", () => {
  const job = makeJob({
    args: ["arg1", "arg2"],
    deno_args: ["--allow-read", "--eval=bad"],
  });
  const cmd = buildCommand(job, "/scripts/test.ts", "deno");
  assertEquals(cmd, [
    "deno",
    "run",
    "--allow-read",
    "/scripts/test.ts",
    "--",
    "arg1",
    "arg2",
  ]);
});

Deno.test("buildCommand: uv with args", () => {
  const job = makeJob({ script: "clean.py", args: ["--verbose"] });
  const cmd = buildCommand(job, "/scripts/clean.py", "uv");
  assertEquals(cmd, ["uv", "run", "/scripts/clean.py", "--", "--verbose"]);
});

Deno.test("buildCommand: bash with args", () => {
  const job = makeJob({ script: "backup.sh", args: ["/data"] });
  const cmd = buildCommand(job, "/scripts/backup.sh", "bash");
  assertEquals(cmd, ["bash", "/scripts/backup.sh", "--", "/data"]);
});
