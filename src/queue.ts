/**
 * Queue manager for reading/writing local/queue.json.
 */

import * as path from "@std/path";
import type { JobInstance, QueueData } from "./types.ts";
import { PROJECT_ROOT } from "./config.ts";
import { createHash } from "node:crypto";

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

/** Generate a UID from script name, args, and current timestamp */
export function generateUid(
  script: string,
  args: string[],
  timestamp?: string,
): string {
  const ts = timestamp ?? new Date().toISOString();
  const hash = createHash("sha256");
  hash.update(`${script}:${JSON.stringify(args)}:${ts}`);
  return hash.digest("hex").slice(0, 12);
}

/** Load queue data from disk */
export async function loadQueue(): Promise<QueueData> {
  try {
    const text = await Deno.readTextFile(QUEUE_PATH);
    return JSON.parse(text) as QueueData;
  } catch {
    return { jobs: [], last_updated: new Date().toISOString() };
  }
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
    uid: generateUid(script, args, now),
    script,
    args,
    deno_args: [],
    run_at,
    next_in,
    status: "pending",
    prev_instance: null,
    output: "",
    timeout_minutes: null,
    created_at: now,
    ...rest,
  };
}
