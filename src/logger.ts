/**
 * Logging utilities for job output and orchestrator logs.
 */

import * as path from "@std/path";
import * as log from "@std/log";
import { PROJECT_ROOT } from "./config.ts";

const LOGS_DIR = path.join(PROJECT_ROOT, "local", "logs");

/** Ensure the logs directory exists */
async function ensureLogsDir(): Promise<void> {
  await Deno.mkdir(LOGS_DIR, { recursive: true });
}

/**
 * Setup the global logger for the orchestrator.
 *
 * Note: Since this is a CLI tool that might run for long periods (poll mode),
 * we use a fixed log file for the duration of the process, but the filename
 * includes the startup date.
 */
export async function setupLogger(
  level: log.LevelName = "INFO",
): Promise<void> {
  await ensureLogsDir();
  const date = new Date().toISOString().slice(0, 10);
  const logFile = path.join(LOGS_DIR, `${date}_orchestrator.log`);

  await log.setup({
    handlers: {
      console: new log.ConsoleHandler(level, {
        formatter: (record) => {
          const time = record.datetime.toISOString();
          return `[${time}] ${record.levelName.padEnd(7)} ${record.msg}`;
        },
      }),
      file: new log.FileHandler(level, {
        filename: logFile,
        bufferSize: 1,
        formatter: (record) => {
          const time = record.datetime.toISOString();
          return `[${time}] ${record.levelName.padEnd(7)} ${record.msg}`;
        },
      }),
    },
    loggers: {
      default: {
        level: level,
        handlers: ["console", "file"],
      },
    },
  });
}

/**
 * Proxy for the default logger to keep existing API simple
 * while we transition.
 */
export const logger = log.getLogger();

/** Write a job's output to a per-instance log file */
export async function writeJobLog(
  uid: string,
  script: string,
  output: string,
): Promise<void> {
  await ensureLogsDir();
  const shortUid = uid.split("-")[0];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}_${
    script.replace(/[/\\]/g, "_")
  }_${shortUid}.log`;
  const filePath = path.join(LOGS_DIR, filename);
  await Deno.writeTextFile(filePath, output + "\n");
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
