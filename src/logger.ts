/**
 * Logging utilities for job output and orchestrator logs.
 */

import * as path from "@std/path";
import { PROJECT_ROOT } from "./config.ts";

const LOGS_DIR = path.join(PROJECT_ROOT, "local", "logs");

/** Ensure the logs directory exists */
async function ensureLogsDir(): Promise<void> {
  await Deno.mkdir(LOGS_DIR, { recursive: true });
}

/** Write a job's output to a per-instance log file */
export async function writeJobLog(
  uid: string,
  script: string,
  output: string,
): Promise<void> {
  await ensureLogsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}_${uid}_${script.replace(/[/\\]/g, "_")}.log`;
  const filePath = path.join(LOGS_DIR, filename);
  await Deno.writeTextFile(filePath, output + "\n");
}

/** Append to the daily orchestrator log and print to console */
export async function logOrchestrator(message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);

  try {
    await ensureLogsDir();
    const date = timestamp.slice(0, 10);
    const filePath = path.join(LOGS_DIR, `orchestrator_${date}.log`);
    await Deno.writeTextFile(filePath, `[${timestamp}] ${message}\n`, {
      append: true,
    });
  } catch (err) {
    console.error(
      `Failed to write to orchestrator log: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/** Clean up old log files based on age or count limits */
export async function cleanupLogs(
  maxAgeDays: number,
  maxEntries: number,
): Promise<void> {
  if (maxAgeDays === 0 && maxEntries === 0) return;
  await ensureLogsDir();

  const entries: { name: string; mtime: Date }[] = [];
  for await (const entry of Deno.readDir(LOGS_DIR)) {
    if (!entry.isFile) continue;
    const stat = await Deno.stat(path.join(LOGS_DIR, entry.name));
    entries.push({ name: entry.name, mtime: stat.mtime ?? new Date(0) });
  }

  // Sort oldest first
  entries.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

  const now = Date.now();
  const toDelete = new Set<string>();

  // By age
  if (maxAgeDays > 0) {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const e of entries) {
      if (e.mtime.getTime() < cutoff) toDelete.add(e.name);
    }
  }

  // By count
  if (maxEntries > 0 && entries.length > maxEntries) {
    const excess = entries.length - maxEntries;
    for (let i = 0; i < excess; i++) {
      toDelete.add(entries[i].name);
    }
  }

  for (const name of toDelete) {
    await Deno.remove(path.join(LOGS_DIR, name));
  }
}
