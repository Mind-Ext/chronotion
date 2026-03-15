/**
 * Queue manager for reading/writing local/queue.json.
 */

import * as path from "@std/path";
import type { JobInstance, MergeResult, QueueData } from "./types.ts";
import { PROJECT_ROOT } from "./config.ts";
import { logger } from "./logger.ts";

const QUEUE_PATH = path.join(PROJECT_ROOT, "local", "queue.json");

let queueLock = Promise.resolve();

/** Run a function with an exclusive lock to prevent file I/O race conditions */
export async function withQueueLock<T>(action: () => Promise<T>): Promise<T> {
  const previousLock = queueLock;
  let releaseLock: () => void;
  queueLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  try {
    await previousLock;
    return await action();
  } finally {
    releaseLock!();
  }
}

/** Generate a unique identifier (UUID v4) */
export function generateUid(): string {
  return crypto.randomUUID();
}

/** Load queue data from disk with retry for mid-edit corruption */
export async function loadQueue(): Promise<QueueData> {
  const maxRetries = 5;
  const retryDelay = 2000; // 2 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const text = await Deno.readTextFile(QUEUE_PATH);
      return JSON.parse(text) as QueueData;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // First run: ensure directory exists and create empty queue
        const dir = path.dirname(QUEUE_PATH);
        await Deno.mkdir(dir, { recursive: true });

        const emptyQueue = {
          jobs: [],
          last_updated: new Date().toISOString(),
        };
        await saveQueue(emptyQueue);
        return emptyQueue;
      }

      // If it's a SyntaxError (invalid JSON), it might be a mid-edit.
      // Wait and retry a few times before giving up.
      if (err instanceof SyntaxError && attempt < maxRetries) {
        logger.warn(
          `Queue file is invalid (mid-edit?). Retrying in ${
            retryDelay / 1000
          }s... (Attempt ${attempt}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        continue;
      }

      // If it's a final attempt or a different error, re-throw.
      throw new Error(
        `Failed to load queue.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  throw new Error("Reached unreachable state in loadQueue");
}

/** Save queue data to disk */
export async function saveQueue(data: QueueData): Promise<void> {
  data.last_updated = new Date().toISOString();
  await Deno.writeTextFile(QUEUE_PATH, JSON.stringify(data, null, 2) + "\n");
}

/** Find a job by UID */
export function findJob(
  queue: QueueData,
  uid: string,
): JobInstance | undefined {
  return queue.jobs.find((j) => j.uid === uid);
}

/** Update a job in the queue (by UID). Returns true if found and updated. */
export function updateJob(
  queue: QueueData,
  uid: string,
  updates: Partial<JobInstance>,
): boolean {
  const idx = queue.jobs.findIndex((j) => j.uid === uid);
  if (idx === -1) return false;
  queue.jobs[idx] = { ...queue.jobs[idx], ...updates };
  return true;
}

/** Add a new job to the queue */
export function addJob(queue: QueueData, job: JobInstance): void {
  queue.jobs.push(job);
}

/** Create a new JobInstance with defaults */
export function createJob(
  params:
    & Pick<JobInstance, "script" | "args" | "run_at" | "next_in">
    & Partial<JobInstance>,
): JobInstance {
  const now = new Date().toISOString();
  const { script, args, run_at, next_in, ...rest } = params;
  return {
    uid: rest.uid ?? generateUid(),
    name: rest.name,
    script,
    args,
    deno_args: [],
    run_at,
    next_in,
    status: "pending",
    end_on: null,
    prev_instance: null,
    next_instance: null,
    output: "",
    timeout_minutes: null,
    created_at: now,
    ...rest,
  };
}

/**
 * Merge remote Notion jobs with local queue state.
 *
 * Strategy: Remote jobs are the source of truth for *definitions*,
 * but local jobs that are currently "running" or recently completed
 * (status is not "pending") must NOT be overwritten by stale remote data.
 *
 * Jobs are matched by uid (primary) or notion_page_id (secondary).
 */
export function mergeWithNotion(
  local: QueueData,
  remote: JobInstance[],
): MergeResult {
  const localByUid = new Map<string, JobInstance>();
  const localByPageId = new Map<string, JobInstance>();

  for (const job of local.jobs) {
    localByUid.set(job.uid, job);
    if (job.notion_page_id) {
      localByPageId.set(job.notion_page_id, job);
    }
  }

  const mergedJobs: JobInstance[] = [];
  const staleRemote: JobInstance[] = [];
  const processedLocalUids = new Set<string>();

  for (const remoteJob of remote) {
    // 1. Try to find local job by UID (Discovery/Reschedule path)
    // 2. Fallback to notion_page_id (Initial import/Manual creation path)
    const localJob = localByUid.get(remoteJob.uid) ||
      (remoteJob.notion_page_id
        ? localByPageId.get(remoteJob.notion_page_id)
        : undefined);

    if (localJob) {
      processedLocalUids.add(localJob.uid);

      // Local job exists — protect running/recently-completed state
      if (
        localJob.status === "running" ||
        localJob.status === "success" ||
        localJob.status === "failed"
      ) {
        // Keep local version — it has fresher execution state.
        // But ensure it now has the notion_page_id if it was missing.
        const updatedLocal = {
          ...localJob,
          notion_page_id: localJob.notion_page_id || remoteJob.notion_page_id,
        };
        mergedJobs.push(updatedLocal);

        // If Notion status doesn't match local terminal status, it's stale
        if (remoteJob.status !== localJob.status) {
          staleRemote.push(updatedLocal);
        }
      } else {
        // Local is pending/error/disabled/skipped — remote is authoritative
        // Preserve local uid for stability
        mergedJobs.push({ ...remoteJob, uid: localJob.uid });
      }
    } else {
      // New remote job not seen locally
      mergedJobs.push(remoteJob);
    }
  }

  // Any remaining local jobs (local-only or not yet synced)
  for (const localJob of local.jobs) {
    if (!processedLocalUids.has(localJob.uid)) {
      mergedJobs.push(localJob);
    }
  }

  return {
    queue: {
      jobs: mergedJobs,
      last_updated: new Date().toISOString(),
    },
    staleRemote,
  };
}

/** Clean up old jobs from the queue based on age or count limits */
export function cleanupQueue(
  queue: QueueData,
  maxAgeDays: number,
  maxEntries: number,
): void {
  if (maxAgeDays === 0 && maxEntries === 0) return;

  // Only consider terminal states for deletion
  const terminalStatuses = ["success", "failed", "error", "skipped"];

  // Find all terminal jobs
  const terminalJobs = queue.jobs.filter((j) =>
    terminalStatuses.includes(j.status)
  );

  if (terminalJobs.length === 0) return;

  // Sort oldest first based on run_at
  terminalJobs.sort((a, b) =>
    new Date(a.run_at).getTime() - new Date(b.run_at).getTime()
  );

  const toDelete = new Set<string>();
  const now = Date.now();

  // By age
  if (maxAgeDays > 0) {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const job of terminalJobs) {
      if (new Date(job.run_at).getTime() < cutoff) {
        toDelete.add(job.uid);
      }
    }
  }

  // By count
  if (maxEntries > 0) {
    const remainingTerminal = terminalJobs.filter((j) => !toDelete.has(j.uid));
    if (remainingTerminal.length > maxEntries) {
      const excess = remainingTerminal.length - maxEntries;
      for (let i = 0; i < excess; i++) {
        toDelete.add(remainingTerminal[i].uid);
      }
    }
  }

  if (toDelete.size > 0) {
    queue.jobs = queue.jobs.filter((j) => !toDelete.has(j.uid));
  }
}
