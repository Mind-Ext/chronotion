import * as path from "@std/path";
import { PROJECT_ROOT } from "./config.ts";

let lockFile: Deno.FsFile | null = null;

/**
 * Attempts to acquire an exclusive process-wide lock for Chronotion.
 * If the lock cannot be acquired, it prints a message and terminates the process.
 *
 * @param customLockPath Optional lock file path override (mainly for testing)
 */
export function acquireProcessLock(customLockPath?: string): void {
  const lockFilePath = customLockPath ??
    path.join(PROJECT_ROOT, "local", "app.lock");
  try {
    Deno.mkdirSync(path.dirname(lockFilePath), { recursive: true });
    lockFile = Deno.openSync(lockFilePath, {
      read: true,
      write: true,
      create: true,
    });

    const acquired = lockFile.tryLockSync(true);
    if (!acquired) {
      console.error(
        "Error: Another instance of Chronotion is already running.",
      );
      try {
        const existingPid = Deno.readTextFileSync(lockFilePath).trim();
        if (existingPid) {
          console.error(`Existing process PID: ${existingPid}`);
        }
      } catch {
        // Ignore read errors
      }
      Deno.exit(1);
    }

    // Write our PID to the lock file
    lockFile.truncateSync(0);
    const encoder = new TextEncoder();
    lockFile.writeSync(encoder.encode(`${Deno.pid}\n`));
  } catch (err) {
    console.error(
      `Failed to acquire process lock: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    Deno.exit(1);
  }
}

/**
 * Releases the acquired process lock if it exists.
 */
export function releaseProcessLock(): void {
  if (lockFile) {
    try {
      lockFile.unlockSync();
      lockFile.close();
    } catch {
      // Ignore errors during cleanup
    } finally {
      lockFile = null;
    }
  }
}
