import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { acquireProcessLock, releaseProcessLock } from "../src/lock.ts";

Deno.test("acquireProcessLock - successful lock acquisition", () => {
  const tempDir = Deno.makeTempDirSync();
  const lockPath = path.join(tempDir, "test.lock");
  try {
    // Should be able to acquire lock
    acquireProcessLock(lockPath);

    // Verify lock file exists and contains current PID
    const content = Deno.readTextFileSync(lockPath).trim();
    assertEquals(content, Deno.pid.toString());
  } finally {
    releaseProcessLock();
    try {
      Deno.removeSync(tempDir, { recursive: true });
    } catch {
      // Ignore
    }
  }
});

Deno.test("acquireProcessLock - fails and exits when already locked by another process", async () => {
  const tempDir = Deno.makeTempDirSync();
  const lockPath = path.join(tempDir, "test.lock");

  // Acquire lock in this main test process
  const file = Deno.openSync(lockPath, {
    read: true,
    write: true,
    create: true,
  });
  const locked = file.tryLockSync(true);
  assertEquals(locked, true);

  // Write dummy PID to file
  file.writeSync(new TextEncoder().encode("99999\n"));

  try {
    // Spawn a subprocess that attempts to acquire the lock and exit
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { acquireProcessLock } from "./src/lock.ts"; acquireProcessLock("${lockPath}");`,
      ],
      stderr: "piped",
      stdout: "piped",
    });

    const { code, stderr } = await command.output();
    const stderrText = new TextDecoder().decode(stderr);

    assertEquals(code, 1);
    assertStringIncludes(
      stderrText,
      "Error: Another instance of Chronotion is already running.",
    );
    assertStringIncludes(stderrText, "Existing process PID: 99999");
  } finally {
    file.unlockSync();
    file.close();
    try {
      Deno.removeSync(tempDir, { recursive: true });
    } catch {
      // Ignore
    }
  }
});
