/**
 * Main orchestrator for Chronotion.
 *
 * Responsibilities:
 * - Crash recovery (detect orphaned "running" jobs on startup)
 * - Job evaluation (find due jobs)
 * - Execution with in-memory locks (prevent double-starts)
 * - Rescheduling after completion
 * - Logging job output
 * - Poll loop or one-off mode
 */

import { loadConfig } from "./config.ts";
import type { AppConfig, JobInstance, QueueData } from "./types.ts";
import { addJob, createJob, loadQueue, saveQueue, updateJob } from "./queue.ts";
import { executeScript } from "./executor.ts";
import {
  computeNextRun,
  dateMatchesMacro,
  validateNextIn,
} from "./schedule.ts";
import { cleanupLogs, logOrchestrator, writeJobLog } from "./logger.ts";

/** In-memory lock set to prevent double-starting jobs */
const activeLocks = new Set<string>();

/** Recover jobs stuck as "running" from a previous crash */
export function recoverZombieJobs(queue: QueueData): number {
  let recovered = 0;
  for (const job of queue.jobs) {
    if (job.status === "running") {
      updateJob(queue, job.uid, {
        status: "error",
        output: "Interrupted by system restart",
      });
      recovered++;
    }
  }
  return recovered;
}

/** Find all jobs that are due for execution */
export function findDueJobs(queue: QueueData): JobInstance[] {
  const now = Date.now();
  return queue.jobs.filter((job) => {
    if (job.status !== "pending") return false;
    if (activeLocks.has(job.uid)) return false;
    const runAt = new Date(job.run_at).getTime();
    return runAt <= now;
  });
}

/** Execute a single job: validate, run, reschedule */
async function executeJob(
  job: JobInstance,
  queue: QueueData,
  config: AppConfig,
): Promise<void> {
  activeLocks.add(job.uid);

  try {
    // Validate next_in expression
    const validationError = validateNextIn(job.next_in);
    if (validationError && validationError !== "never") {
      updateJob(queue, job.uid, {
        status: "error",
        output: `Invalid schedule: ${validationError}`,
      });
      await logOrchestrator(
        `[${job.uid}] ${job.script}: schedule error - ${validationError}`,
      );
      return;
    }

    // Validate macro alignment for first instance (no prev_instance)
    if (
      !job.prev_instance && !dateMatchesMacro(new Date(job.run_at), job.next_in)
    ) {
      updateJob(queue, job.uid, {
        status: "error",
        output:
          `First instance run_at does not align with macro "${job.next_in}". Scheduling next correct instance.`,
      });
      await scheduleNext(job, queue);
      await logOrchestrator(
        `[${job.uid}] ${job.script}: macro misalignment, rescheduled`,
      );
      return;
    }

    // Mark as running
    updateJob(queue, job.uid, { status: "running" });
    await saveQueue(queue);
    await logOrchestrator(`[${job.uid}] ${job.script}: started`);

    // Execute
    const result = await executeScript(job, config.scripts_dir);

    // Update status
    const newStatus = result.success ? "success" : "failed";
    updateJob(queue, job.uid, {
      status: newStatus,
      output: result.output,
    });

    // Write log file
    await writeJobLog(job.uid, job.script, result.output);
    await logOrchestrator(
      `[${job.uid}] ${job.script}: ${newStatus} (exit ${result.exitCode})`,
    );

    // Reschedule
    await scheduleNext(job, queue);
  } finally {
    activeLocks.delete(job.uid);
  }
}

/** Schedule the next instance of a job based on next_in */
async function scheduleNext(
  job: JobInstance,
  queue: QueueData,
): Promise<void> {
  const anchor = new Date(job.run_at);
  const result = computeNextRun(anchor, job.next_in);

  if (!result.ok) {
    if (result.error !== "never") {
      await logOrchestrator(
        `[${job.uid}] ${job.script}: reschedule error - ${result.error}`,
      );
    }
    return; // One-off job or error, no rescheduling
  }

  const nextJob = createJob({
    script: job.script,
    args: [...job.args],
    deno_args: [...job.deno_args],
    run_at: result.next.toISOString(),
    next_in: job.next_in,
    prev_instance: job.uid,
    timeout_minutes: job.timeout_minutes,
  });

  addJob(queue, nextJob);
  await logOrchestrator(
    `[${nextJob.uid}] ${job.script}: scheduled for ${nextJob.run_at}`,
  );
}

/** Run one evaluation cycle */
export async function runCycle(config: AppConfig): Promise<void> {
  const queue = await loadQueue();

  // Find and execute due jobs concurrently
  const dueJobs = findDueJobs(queue);

  if (dueJobs.length > 0) {
    await logOrchestrator(`Found ${dueJobs.length} due job(s)`);

    await Promise.all(
      dueJobs.map((job) => executeJob(job, queue, config)),
    );

    await saveQueue(queue);
  }
}

/** Main entry point */
async function main(): Promise<void> {
  const config = await loadConfig();

  console.log("Chronotion starting...");
  console.log(`  Mode: ${config.local_mode ? "local" : "notion"}`);
  console.log(`  One-off: ${config.oneoff_mode}`);
  console.log(`  Poll interval: ${config.poll_minutes}m`);
  console.log(`  Scripts dir: ${config.scripts_dir}`);

  // Crash recovery
  const queue = await loadQueue();
  const recovered = recoverZombieJobs(queue);
  if (recovered > 0) {
    await saveQueue(queue);
    await logOrchestrator(`Recovered ${recovered} zombie job(s)`);
    console.log(`  Recovered ${recovered} zombie job(s)`);
  }

  // Log cleanup
  await cleanupLogs(config.log_max_age_days, config.log_max_entries);

  if (config.oneoff_mode) {
    // Single run
    await runCycle(config);
    console.log("One-off cycle complete.");
  } else {
    // Poll loop
    console.log("Starting poll loop...");
    await logOrchestrator("Orchestrator started (poll mode)");

    while (true) {
      await runCycle(config);
      await new Promise((resolve) =>
        setTimeout(resolve, config.poll_minutes * 60 * 1000)
      );
    }
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}
