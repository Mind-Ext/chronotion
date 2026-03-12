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
 * - Notion sync (pull/push) when local_mode is false
 */

import { loadConfig } from "./config.ts";
import type { AppConfig, JobInstance, QueueData } from "./types.ts";
import {
  addJob,
  createJob,
  loadQueue,
  mergeWithNotion,
  saveQueue,
  updateJob,
  withQueueLock,
} from "./queue.ts";
import { executeScript } from "./executor.ts";
import { computeNextRun, validateNextIn } from "./schedule.ts";
import { cleanupLogs, logOrchestrator, writeJobLog } from "./logger.ts";
import {
  createNextInstance,
  FetchedJob,
  fetchJobs,
  initDatabaseSchema,
  updateNotionJob,
} from "./notion.ts";

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

/** Validate newly pulled Notion jobs that lack an initial status */
async function validateNewJobs(
  remoteJobs: FetchedJob[],
  config: AppConfig,
): Promise<void> {
  for (const rJob of remoteJobs) {
    if (rJob._notion_status_is_null) {
      let errorMsg = null;
      if (!rJob.script || rJob.script.trim() === "") {
        errorMsg = "Validation failed: Missing script name.";
      } else {
        const validationError = validateNextIn(rJob.next_in);
        if (validationError && validationError !== "never") {
          errorMsg = `Validation failed: Invalid schedule - ${validationError}`;
        }
      }

      const scriptName = rJob.script || "unknown";

      if (errorMsg) {
        rJob.status = "error";
        rJob.output = errorMsg;
        await logOrchestrator(`[${rJob.uid}] ${scriptName}: ${errorMsg}`);
      } else {
        rJob.status = "pending";
        rJob.output = "Job validated and registered successfully.";
        await logOrchestrator(`[${rJob.uid}] ${scriptName}: Validated new job`);
      }

      try {
        await updateNotionJob(rJob, config);
      } catch (err) {
        await logOrchestrator(
          `[${rJob.uid}] ${scriptName}: Notion validation push failed - ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

/** Execute a single job: validate, run, reschedule */
async function executeJob(
  job: JobInstance,
  config: AppConfig,
): Promise<void> {
  // activeLocks is already set by runCycle

  try {
    // Validate next_in expression
    const validationError = validateNextIn(job.next_in);
    if (validationError && validationError !== "never") {
      const markJobAsScheduleError = async () => {
        const queue = await loadQueue();
        updateJob(queue, job.uid, {
          status: "error",
          output: `Invalid schedule: ${validationError}`,
        });
        await saveQueue(queue);
      };
      await withQueueLock(markJobAsScheduleError);

      await logOrchestrator(
        `[${job.uid}] ${job.script}: schedule error - ${validationError}`,
      );
      return;
    }

    await logOrchestrator(`[${job.uid}] ${job.script}: started`);

    // Execute
    const result = await executeScript(job, config);

    // Update status
    const newStatus = result.success ? "success" : "failed";

    let updatedJob: JobInstance | undefined;
    const processExecutionResult = async () => {
      const queue = await loadQueue();
      updateJob(queue, job.uid, {
        status: newStatus,
        output: result.output,
      });
      // Reschedule
      await scheduleNext(job, queue, config);
      await saveQueue(queue);
      updatedJob = queue.jobs.find((j) => j.uid === job.uid);
    };
    await withQueueLock(processExecutionResult);

    // Push to Notion (error-isolated)
    if (!config.local_mode && updatedJob) {
      try {
        await updateNotionJob(
          { ...updatedJob, status: newStatus, output: result.output },
          config,
        );
      } catch (err) {
        await logOrchestrator(
          `[${job.uid}] ${job.script}: Notion push failed - ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Write log file
    await writeJobLog(job.uid, job.script, result.output);
    await logOrchestrator(
      `[${job.uid}] ${job.script}: ${newStatus} (exit ${result.exitCode})`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await logOrchestrator(
      `[${job.uid}] ${job.script}: unexpected orchestrator error - ${errorMsg}`,
    );

    // Safely attempt to set job to error state
    try {
      let errorJob: JobInstance | undefined;
      const markJobAsErrorState = async () => {
        const queue = await loadQueue();
        updateJob(queue, job.uid, {
          status: "error",
          output: `Orchestrator Error: ${errorMsg}`,
        });
        await saveQueue(queue);
        errorJob = queue.jobs.find((j) => j.uid === job.uid);
      };
      await withQueueLock(markJobAsErrorState);

      if (!config.local_mode && errorJob) {
        await updateNotionJob(errorJob, config);
      }
    } catch (recoveryErr) {
      await logOrchestrator(
        `[${job.uid}] ${job.script}: failed to recover job state - ${
          recoveryErr instanceof Error
            ? recoveryErr.message
            : String(recoveryErr)
        }`,
      );
    }
  } finally {
    activeLocks.delete(job.uid);
  }
}

/** Schedule the next instance of a job based on next_in */
async function scheduleNext(
  job: JobInstance,
  queue: QueueData,
  config: AppConfig,
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

  // Check end_on
  if (job.end_on && result.next.getTime() > new Date(job.end_on).getTime()) {
    await logOrchestrator(
      `[${job.uid}] ${job.script}: reached end_on date, not rescheduling`,
    );
    return;
  }

  const nextRunAt = result.next.toISOString();

  // Create next instance in Notion if in remote mode
  let notionPageId: string | undefined;
  if (!config.local_mode && job.notion_page_id) {
    try {
      notionPageId = await createNextInstance(job, nextRunAt, config);
    } catch (err) {
      await logOrchestrator(
        `[${job.uid}] ${job.script}: Notion reschedule failed - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const nextJob = createJob({
    name: job.name,
    script: job.script,
    args: [...job.args],
    deno_args: [...job.deno_args],
    run_at: nextRunAt,
    next_in: job.next_in,
    prev_instance: job.uid,
    timeout_minutes: job.timeout_minutes,
    end_on: job.end_on,
    notion_page_id: notionPageId,
  });

  job.next_instance = nextJob.uid;
  updateJob(queue, job.uid, { next_instance: nextJob.uid });

  addJob(queue, nextJob);
  await logOrchestrator(
    `[${nextJob.uid}] ${job.script}: scheduled for ${nextJob.run_at}`,
  );
}

/** Run one evaluation cycle */
export async function runCycle(
  config: AppConfig,
  isOneOff: boolean = false,
): Promise<void> {
  // ── Pull from Notion (error-isolated) ──
  if (!config.local_mode) {
    try {
      const remoteJobs = await fetchJobs();

      // Proactive validation for newly created Notion jobs
      await validateNewJobs(remoteJobs, config);

      const syncRemoteJobsToLocalQueue = async () => {
        const localQueue = await loadQueue();
        const merged = mergeWithNotion(localQueue, remoteJobs);
        await saveQueue(merged);
      };

      await withQueueLock(syncRemoteJobsToLocalQueue);

      await logOrchestrator(
        `Pulled ${remoteJobs.length} job(s) from Notion`,
      );
    } catch (err) {
      await logOrchestrator(
        `Notion pull failed - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Evaluate & Execute ──
  const dueJobs = await claimDueJobs(config);

  if (dueJobs.length > 0) {
    await logOrchestrator(`Found ${dueJobs.length} due job(s)`);

    const promises = dueJobs.map((job) => executeJob(job, config));

    if (isOneOff) {
      await Promise.all(promises);
    } else {
      promises.forEach((p) => p.catch(console.error));
    }
  }
}

/** Lock and claim due jobs, setting their status to running */
async function claimDueJobs(config: AppConfig): Promise<JobInstance[]> {
  let dueJobs: JobInstance[] = [];

  const processQueue = async () => {
    const queue = await loadQueue();
    dueJobs = findDueJobs(queue);

    if (dueJobs.length === 0) return;

    for (const job of dueJobs) {
      updateJob(queue, job.uid, { status: "running" });
      activeLocks.add(job.uid);
    }
    await saveQueue(queue);

    // Push "running" status to Notion
    if (config.local_mode) return;

    for (const job of dueJobs) {
      if (!job.notion_page_id) continue;

      try {
        await updateNotionJob({ ...job, status: "running" }, config);
      } catch (err) {
        await logOrchestrator(
          `[${job.uid}] ${job.script}: Notion status push failed - ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  };

  await withQueueLock(processQueue);

  return dueJobs;
}

/** Main entry point */
async function main(): Promise<void> {
  const args = Deno.args;
  const isOneOff = args.includes("--one-off");
  const isPoll = args.includes("--poll");

  if (!isOneOff && !isPoll) {
    console.error("Error: You must specify either --one-off or --poll.");
    Deno.exit(1);
  }

  if (isOneOff && isPoll) {
    console.error("Error: Cannot specify both --one-off and --poll.");
    Deno.exit(1);
  }

  const config = await loadConfig();

  await logOrchestrator("Chronotion starting...");
  await logOrchestrator(
    `Data source: ${config.local_mode ? "local" : "notion"}`,
  );
  await logOrchestrator(`Execution mode: ${isOneOff ? "one-off" : "poll"}`);
  if (!isOneOff) {
    await logOrchestrator(`Poll interval: ${config.poll_minutes}m`);
  }
  await logOrchestrator(`Scripts dir: ${config.scripts_dir}`);

  // Initialize Notion schema if in remote mode
  if (!config.local_mode) {
    try {
      await initDatabaseSchema();
      await logOrchestrator("Notion database schema verified.");
    } catch (err) {
      await logOrchestrator(
        `Warning: Notion schema init failed - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Crash recovery
  const queue = await loadQueue();
  const recovered = recoverZombieJobs(queue);
  if (recovered > 0) {
    await saveQueue(queue);
    await logOrchestrator(`Recovered ${recovered} zombie job(s)`);
  }

  // Log cleanup
  await cleanupLogs(config.log_max_age_days, config.log_max_entries);

  if (isOneOff) {
    // Single run
    await runCycle(config, true);
    await logOrchestrator("One-off cycle complete.");
  } else {
    // Poll loop
    await logOrchestrator("Starting poll loop...");
    await logOrchestrator("Orchestrator started (poll mode)");

    while (true) {
      await runCycle(config, false);
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
