import { assertEquals } from "@std/assert";
import {
  buildCommand,
  buildSubprocessEnv,
  detectRuntimeCommand,
  parseShebangRuntime,
  sanitizeDenoArgs,
  validateScriptPath,
} from "../src/executor.ts";
import type { JobInstance } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

// --- Runtime detection ---

Deno.test("detectRuntimeCommand: typescript", async () => {
  assertEquals(
    await detectRuntimeCommand("/scripts/sync.ts", DEFAULT_CONFIG.runtimes),
    ["deno", "run"],
  );
});

Deno.test("detectRuntimeCommand: javascript", async () => {
  assertEquals(
    await detectRuntimeCommand("/scripts/sync.js", DEFAULT_CONFIG.runtimes),
    ["deno", "run"],
  );
});

Deno.test("detectRuntimeCommand: python", async () => {
  assertEquals(
    await detectRuntimeCommand("/scripts/clean.py", DEFAULT_CONFIG.runtimes),
    ["uv", "run"],
  );
});

Deno.test("detectRuntimeCommand: bash", async () => {
  assertEquals(
    await detectRuntimeCommand("/scripts/backup.sh", DEFAULT_CONFIG.runtimes),
    ["bash"],
  );
});

Deno.test("detectRuntimeCommand: unknown", async () => {
  assertEquals(
    await detectRuntimeCommand("/scripts/file.xyz", DEFAULT_CONFIG.runtimes),
    null,
  );
});

Deno.test("detectRuntimeCommand: picks up shebang from real file", async () => {
  const tmp = await writeTemp("#!/usr/bin/env bun\nconsole.log('hi');\n");
  try {
    assertEquals(await detectRuntimeCommand(tmp, DEFAULT_CONFIG.runtimes), [
      "bun",
    ]);
  } finally {
    await Deno.remove(tmp);
  }
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

// --- Subprocess environment ---

Deno.test("buildSubprocessEnv: preserves PATH, HOME, and config env", () => {
  const result = buildSubprocessEnv(
    { API_TOKEN: "secret", PATH: "/custom/bin" },
    { PATH: "/usr/bin", HOME: "/home/test" },
  );

  assertEquals(result, {
    PATH: "/custom/bin",
    HOME: "/home/test",
    API_TOKEN: "secret",
  });
});

Deno.test("buildSubprocessEnv: excludes unrelated parent env", () => {
  const result = buildSubprocessEnv(
    {},
    { PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "nope" },
  );

  assertEquals(result, { PATH: "/usr/bin" });
});

// --- Command building ---

function makeJob(overrides: Partial<JobInstance> = {}): JobInstance {
  return {
    uid: "test123",
    script: "test.ts",
    args: [],
    deno_args: [],
    scheduled_at: "2024-06-01T12:00:00Z",
    finished_at: null,
    next_in: "1d",
    status: "pending",
    end_on: null,
    prev_instance: null,
    next_instance: null,
    output: "",
    timeout_minutes: null,
    created_at: "2024-06-01T00:00:00Z",
    ...overrides,
  };
}

Deno.test("buildCommand: deno with no args", () => {
  const job = makeJob();
  const cmd = buildCommand(job, "/scripts/test.ts", ["deno", "run"]);
  assertEquals(cmd, ["deno", "run", "--", "/scripts/test.ts"]);
});

Deno.test("buildCommand: deno with args and permissions", () => {
  const job = makeJob({
    args: ["arg1", "arg2"],
    deno_args: ["--allow-read", "--eval=bad"],
  });
  const cmd = buildCommand(job, "/scripts/test.ts", ["deno", "run"]);
  assertEquals(cmd, [
    "deno",
    "run",
    "--allow-read",
    "--",
    "/scripts/test.ts",
    "arg1",
    "arg2",
  ]);
});

Deno.test("buildCommand: deno with global base permissions", () => {
  const job = makeJob({
    args: ["arg1"],
    deno_args: ["--allow-read"],
  });
  const cmd = buildCommand(job, "/scripts/test.ts", [
    "deno",
    "run",
    "--allow-net",
    "--unstable",
  ]);
  assertEquals(cmd, [
    "deno",
    "run",
    "--allow-net",
    "--unstable",
    "--allow-read",
    "--",
    "/scripts/test.ts",
    "arg1",
  ]);
});

Deno.test("buildCommand: uv with args", () => {
  const job = makeJob({ script: "clean.py", args: ["--verbose"] });
  const cmd = buildCommand(job, "/scripts/clean.py", ["uv", "run"]);
  assertEquals(cmd, ["uv", "run", "/scripts/clean.py", "--", "--verbose"]);
});

Deno.test("buildCommand: bash with args", () => {
  const job = makeJob({ script: "backup.sh", args: ["/data"] });
  const cmd = buildCommand(job, "/scripts/backup.sh", ["bash"]);
  assertEquals(cmd, ["bash", "/scripts/backup.sh", "/data"]);
});

// --- Shebang parsing ---

async function writeTemp(contents: string): Promise<string> {
  const tmp = await Deno.makeTempFile({ prefix: "chronotion_test_" });
  await Deno.writeTextFile(tmp, contents);
  return tmp;
}

Deno.test("parseShebangRuntime: /bin/bash", async () => {
  const tmp = await writeTemp("#!/bin/bash\necho hello\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["/bin/bash"]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: /usr/bin/env deno", async () => {
  const tmp = await writeTemp("#!/usr/bin/env deno\nconsole.log('hi');\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["deno"]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: /usr/bin/env bun", async () => {
  const tmp = await writeTemp("#!/usr/bin/env bun\nconsole.log('hi');\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["bun"]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: /usr/bin/env python3", async () => {
  const tmp = await writeTemp("#!/usr/bin/env python3\nprint('hi')\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["python3"]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: /bin/sh", async () => {
  const tmp = await writeTemp("#!/bin/sh\necho hi\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["/bin/sh"]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: /usr/bin/env node", async () => {
  const tmp = await writeTemp("#!/usr/bin/env node\nconsole.log('hi');\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["node"]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: no shebang returns null", async () => {
  const tmp = await writeTemp("echo hello\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), null);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: file not found returns null", async () => {
  assertEquals(
    await parseShebangRuntime("/nonexistent/path_12345_test"),
    null,
  );
});

Deno.test("parseShebangRuntime: shebang with argument", async () => {
  const tmp = await writeTemp("#!/bin/bash -e\necho hi\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["/bin/bash", "-e"]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: env with no argument returns null", async () => {
  const tmp = await writeTemp("#!/usr/bin/env\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), null);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: env -S forwards full command after -S", async () => {
  const tmp = await writeTemp(
    "#!/usr/bin/env -S deno run --allow-env\nconsole.log('hi');\n",
  );
  try {
    assertEquals(await parseShebangRuntime(tmp), [
      "deno",
      "run",
      "--allow-env",
    ]);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: env -S with no command returns null", async () => {
  const tmp = await writeTemp("#!/usr/bin/env -S\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), null);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: empty shebang returns null", async () => {
  const tmp = await writeTemp("#!\necho hi\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), null);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("parseShebangRuntime: env with deno for full path", async () => {
  const tmp = await writeTemp("#!/usr/bin/env deno\nconsole.log('hi');\n");
  try {
    assertEquals(await parseShebangRuntime(tmp), ["deno"]);
  } finally {
    await Deno.remove(tmp);
  }
});
