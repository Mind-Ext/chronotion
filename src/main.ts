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
  cleanupQueue,
  createJob,
  generateUid,
  loadQueue,
  mergeWithNotion,
  saveQueue,
  updateJob,
  withQueueLock,
} from "./queue.ts";
import { executeScript } from "./executor.ts";
import { computeNextRun, validateNextIn } from "./schedule.ts";
import { cleanupLogs, logger, setupLogger, writeJobLog } from "./logger.ts";
import {
  createNextNotionInstance,
  fetchJobs,
  initDatabaseSchema,
  updateNotionJob,
} from "./notion.ts";
import { validateNotionEnvVars } from "./notion_utils.ts";
import "@std/dotenv/load";

/** In-memory task registry to track running promises and prevent double-starting */
const activeTasks = new Map<string, Promise<void>>();

/** Mark orphaned running jobs as error when no active in-process task exists */
export function markOrphanedRunningJobsAsError(
  queue: QueueData,
  tasks: ReadonlyMap<string, Promise<void>> = activeTasks,
): JobInstance[] {
  const recovered: JobInstance[] = [];
  const finishedAt = new Date().toISOString();
  for (const job of queue.jobs) {
    if (job.status === "running" && !tasks.has(job.uid)) {
      job.status = "error";
      job.output = "Orchestrator interrupted: job was left in running state";
      job.finished_at = finishedAt;
      recovered.push({ ...job });
    }
  }
  return recovered;
}

async function syncOrphanedJobsToNotion(
  jobs: JobInstance[],
  config: AppConfig,
): Promise<void> {
  if (config.local_mode) return;

  for (const job of jobs) {
    if (!job.notion_page_id) continue;

    try {
      await updateNotionJob(job, config);
    } catch (err) {
      logger.error(
        `[${job.uid}] ${job.script}: Notion orphan job push failed - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function finalizeOrphanedRunningJobs(config: AppConfig): Promise<void> {
  let orphanedJobs: JobInstance[] = [];

  const markJobs = async () => {
    const queue = await loadQueue();
    orphanedJobs = markOrphanedRunningJobsAsError(queue);
    if (orphanedJobs.length > 0) {
      await saveQueue(queue);
    }
  };
  await withQueueLock(markJobs);

  if (orphanedJobs.length === 0) return;

  logger.info(
    `Marked ${orphanedJobs.length} orphaned running job(s) as error`,
  );
  await syncOrphanedJobsToNotion(orphanedJobs, config);
}

/** Find all jobs that are due for execution */
export function findDueJobs(queue: QueueData): JobInstance[] {
  const now = Date.now();
  return queue.jobs.filter((job) => {
    if (job.status !== "pending") return false;
    if (activeTasks.has(job.uid)) return false;
    const scheduledAt = new Date(job.scheduled_at).getTime();
    return scheduledAt <= now;
  });
}

/** Validate newly pulled Notion jobs that lack an initial status */
async function validateNewJobs(
  remoteJobs: JobInstance[],
  config: AppConfig,
): Promise<void> {
  // Sort jobs by created_at to ensure the oldest gets to keep the UID when checking for duplicates
  remoteJobs.sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  const processQueue = async () => {
    let queue: QueueData | null = null;
    let queueModified = false;
    const seenUids = new Set<string>();

    for (const rJob of remoteJobs) {
      // Resolve duplicate UIDs
      if (seenUids.has(rJob.uid)) {
        rJob.uid = crypto.randomUUID();
        if (rJob.status !== null) {
          try {
            await updateNotionJob(rJob, config);
            logger.info(`[${rJob.uid}] ${rJob.script}: Resolved duplicate UID`);
          } catch (err) {
            logger.error(
              `[${rJob.uid}] ${rJob.script}: Failed to update UID - ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
      seenUids.add(rJob.uid);

      if (rJob.status === null) {
        let errorMsg = null;
        if (!rJob.script || rJob.script.trim() === "") {
          errorMsg = "Validation failed: Missing script name.";
        } else if (!rJob.scheduled_at || rJob.scheduled_at.trim() === "") {
          errorMsg = "Validation failed: Missing scheduled_at (start time).";
        } else {
          const validationError = validateNextIn(rJob.next_in);
          if (validationError) {
            errorMsg =
              `Validation failed: Invalid schedule - ${validationError}`;
          }
        }

        const scriptName = rJob.script || "unknown";

        if (errorMsg) {
          rJob.status = "error";
          rJob.output = errorMsg;
          logger.error(`[${rJob.uid}] ${scriptName}: ${errorMsg}`);
        } else {
          rJob.status = "pending";
          rJob.output = "Job validated and registered successfully.";
          logger.info(
            `[${rJob.uid}] ${scriptName}: Validated new job`,
          );
        }

        try {
          await updateNotionJob(rJob, config);
        } catch (err) {
          logger.error(
            `[${rJob.uid}] ${scriptName}: Notion validation push failed - ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else if (rJob.status === "skipped") {
        // If user manually marked a job as skipped in Notion,
        // we should instantly compute its next run and push it to Notion.
        if (!queue) queue = await loadQueue();

        // Ensure this skipped job isn't already processed (has a next_instance)
        const localJob = queue.jobs.find(
          (j) => (j.notion_page_id === rJob.uid || j.uid === rJob.uid),
        );

        // We only reschedule if it hasn't spawned a next_instance yet
        if (localJob && !localJob.next_instance) {
          logger.info(
            `[${localJob.uid}] ${localJob.script}: User marked as skipped, rescheduling next instance`,
          );
          await scheduleNext(localJob, queue, config);
          queueModified = true;
        }
      }
    }

    if (queueModified && queue) {
      await saveQueue(queue);
    }
  };

  if (!config.local_mode) {
    await withQueueLock(processQueue);
  }
}

/** Execute a single job: validate, run, reschedule */
async function executeJob(
  job: JobInstance,
  config: AppConfig,
): Promise<void> {
  // activeTasks registration is handled by runCycle or claimDueJobs

  try {
    // Validate next_in expression
    const validationError = validateNextIn(job.next_in);
    if (validationError) {
      const markJobAsScheduleError = async () => {
        const queue = await loadQueue();
        updateJob(queue, job.uid, {
          status: "error",
          output: `Invalid schedule: ${validationError}`,
        });
        await saveQueue(queue);
      };
      await withQueueLock(markJobAsScheduleError);

      logger.error(
        `[${job.uid}] ${job.script}: schedule error - ${validationError}`,
      );
      return;
    }

    logger.info(`[${job.uid}] ${job.script}: started`);

    // Execute
    const result = await executeScript(job, config);

    // Update status
    const newStatus = result.success ? "success" : "failed";
    const finishedAt = new Date().toISOString();

    let updatedJob: JobInstance | undefined;
    const processExecutionResult = async () => {
      const queue = await loadQueue();
      updateJob(queue, job.uid, {
        status: newStatus,
        output: result.output,
        finished_at: finishedAt,
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
          {
            ...updatedJob,
            status: newStatus,
            output: result.output,
            finished_at: finishedAt,
          },
          config,
        );
      } catch (err) {
        logger.error(
          `[${job.uid}] ${job.script}: Notion push failed - ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Write log file
    await writeJobLog(job.uid, job.script, result.output);
    logger.info(
      `[${job.uid}] ${job.script}: ${newStatus} (exit ${result.exitCode})`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      `[${job.uid}] ${job.script}: unexpected orchestrator error - ${errorMsg}`,
    );

    // Safely attempt to set job to error state
    try {
      const finishedAt = new Date().toISOString();
      let errorJob: JobInstance | undefined;
      const markJobAsErrorState = async () => {
        const queue = await loadQueue();
        updateJob(queue, job.uid, {
          status: "error",
          output: `Orchestrator Error: ${errorMsg}`,
          finished_at: finishedAt,
        });
        // Reschedule to ensure recurring jobs continue
        await scheduleNext(job, queue, config);
        await saveQueue(queue);
        errorJob = queue.jobs.find((j) => j.uid === job.uid);
      };
      await withQueueLock(markJobAsErrorState);

      if (!config.local_mode && errorJob) {
        await updateNotionJob(errorJob, config);
      }
    } catch (recoveryErr) {
      logger.error(
        `[${job.uid}] ${job.script}: failed to recover job state - ${
          recoveryErr instanceof Error
            ? recoveryErr.message
            : String(recoveryErr)
        }`,
      );
    }
  } finally {
    activeTasks.delete(job.uid);
  }
}

/** Schedule the next instance of a job based on next_in */
async function scheduleNext(
  job: JobInstance,
  queue: QueueData,
  config: AppConfig,
): Promise<void> {
  let anchor = new Date(job.scheduled_at);
  let result = computeNextRun(anchor, job.next_in);

  if (!result.ok) {
    if (result.error !== "never") {
      logger.error(
        `[${job.uid}] ${job.script}: reschedule error - ${result.error}`,
      );
    }
    return; // One-off job or error, no rescheduling
  }

  const now = new Date();
  let iterations = 0;
  const maxIterations = 10000;

  // Fast-forward schedule if behind
  while (result.ok && result.next < now && iterations < maxIterations) {
    anchor = result.next;
    result = computeNextRun(anchor, job.next_in);
    iterations++;
  }

  if (iterations >= maxIterations) {
    logger.warn(
      `[${job.uid}] ${job.script}: schedule too far behind, reached fast-forward limit`,
    );
    return;
  }

  if (!result.ok) {
    return; // Failsafe
  }

  // Check end_on
  if (job.end_on && result.next.getTime() > new Date(job.end_on).getTime()) {
    logger.info(
      `[${job.uid}] ${job.script}: reached end_on date, not rescheduling`,
    );
    return;
  }

  const nextRunAt = result.next.toISOString();
  const nextUid = generateUid();

  // 1. Create local job first (Local First)
  const nextJob = createJob({
    uid: nextUid,
    name: job.name,
    script: job.script,
    args: [...job.args],
    deno_args: [...job.deno_args],
    scheduled_at: nextRunAt,
    next_in: job.next_in,
    prev_instance: job.uid,
    timeout_minutes: job.timeout_minutes,
    end_on: job.end_on,
  });

  job.next_instance = nextJob.uid;
  updateJob(queue, job.uid, { next_instance: nextJob.uid });
  addJob(queue, nextJob);

  logger.info(
    `[${nextJob.uid}] ${job.script}: scheduled for ${nextJob.scheduled_at}`,
  );

  // 2. Best-effort Notion creation (Self-healing will fix on failure)
  if (!config.local_mode && job.notion_page_id) {
    try {
      const notionPageId = await createNextNotionInstance(
        job,
        nextRunAt,
        config,
        nextUid,
      );
      // Link the ID immediately if successful
      nextJob.notion_page_id = notionPageId;
    } catch (err) {
      logger.error(
        `[${job.uid}] ${job.script}: Notion reschedule failed - ${
          err instanceof Error ? err.message : String(err)
        }. Will attempt discovery in next poll.`,
      );
    }
  }
}

/** Run one evaluation cycle */
export async function runCycle(
  config: AppConfig,
  isOneOff: boolean = false,
): Promise<void> {
  await finalizeOrphanedRunningJobs(config);

  // ── Cleanup (log and queue) ──
  try {
    await cleanupLogs(config.history_max_age_days, config.history_max_entries);
    await withQueueLock(async () => {
      const queue = await loadQueue();
      const beforeCount = queue.jobs.length;
      cleanupQueue(
        queue,
        config.history_max_age_days,
        config.history_max_entries,
      );
      if (queue.jobs.length < beforeCount) {
        await saveQueue(queue);
        logger.info(
          `Cleaned up ${beforeCount - queue.jobs.length} old job(s) from queue`,
        );
      }
    });
  } catch (err) {
    logger.error(
      `Cleanup failed - ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Pull from Notion (error-isolated) ──
  if (!config.local_mode) {
    try {
      const remoteJobs = await fetchJobs();

      // Proactive validation for newly created Notion jobs
      await validateNewJobs(remoteJobs, config);

      let staleJobs: JobInstance[] = [];

      const syncRemoteJobsToLocalQueue = async () => {
        const localQueue = await loadQueue();
        const { queue: merged, staleRemote } = mergeWithNotion(
          localQueue,
          remoteJobs,
        );
        await saveQueue(merged);
        staleJobs = staleRemote;
      };

      await withQueueLock(syncRemoteJobsToLocalQueue);

      logger.info(
        `Pulled ${remoteJobs.length} job(s) from Notion`,
      );

      // Re-sync stale jobs back to Notion (best-effort)
      for (const job of staleJobs) {
        try {
          await updateNotionJob(job, config);
        } catch (err) {
          logger.error(
            `[${job.uid}] ${job.script}: Notion re-sync failed - ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      logger.error(
        `Notion pull failed - ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Evaluate & Execute ──
  const dueJobs = await claimDueJobs(config);

  if (dueJobs.length > 0) {
    logger.info(`Found ${dueJobs.length} due job(s)`);

    const promises = dueJobs.map((job) => {
      const p = executeJob(job, config);
      activeTasks.set(job.uid, p);
      return p;
    });

    if (isOneOff) {
      await Promise.all(promises);
    } else {
      // Background execution: individual promises handle their own cleanup/logging,
      // but we add a failsafe catch for the orchestrator promise itself.
      promises.forEach((p) =>
        p.catch((err) => logger.error(`Background task failed - ${err}`))
      );
    }
  }
}

/** Lock and claim due jobs, setting their status to running */
async function claimDueJobs(config: AppConfig): Promise<JobInstance[]> {
  const dueJobs: JobInstance[] = [];

  const processQueue = async () => {
    const queue = await loadQueue();
    const allDueJobs = findDueJobs(queue);

    if (allDueJobs.length === 0) return;

    const now = new Date();

    for (const job of allDueJobs) {
      const scheduledAt = new Date(job.scheduled_at);
      const ageMinutes = (now.getTime() - scheduledAt.getTime()) / 60000;

      if (config.lookback_minutes > 0 && ageMinutes > config.lookback_minutes) {
        logger.warn(
          `[${job.uid}] ${job.script}: missed due to exceeding lookback period (${
            Math.round(ageMinutes)
          }m > ${config.lookback_minutes}m)`,
        );
        const finishedAt = now.toISOString();
        updateJob(queue, job.uid, {
          status: "missed",
          finished_at: finishedAt,
        });
        await scheduleNext(job, queue, config);

        // Push status to Notion if needed
        if (!config.local_mode && job.notion_page_id) {
          updateNotionJob(
            { ...job, status: "missed", finished_at: finishedAt },
            config,
          )
            .catch((e: unknown) =>
              console.error("Failed to update missed status to Notion", e)
            );
        }
      } else {
        updateJob(queue, job.uid, { status: "running" });
        // Reserve task in-memory with a placeholder promise to prevent double-starts
        activeTasks.set(job.uid, Promise.resolve());
        dueJobs.push(job);
      }
    }

    if (allDueJobs.length > 0) {
      await saveQueue(queue);
    }

    // Push "running" status to Notion
    if (config.local_mode) return;

    for (const job of dueJobs) {
      if (!job.notion_page_id) continue;

      try {
        await updateNotionJob({ ...job, status: "running" }, config);
      } catch (err) {
        logger.error(
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

  let config = await loadConfig();
  await setupLogger();

  logger.info("Chronotion starting...");
  logger.info(
    `Data source: ${config.local_mode ? "local" : "notion"}`,
  );
  logger.info(`Execution mode: ${isOneOff ? "one-off" : "poll"}`);
  if (!isOneOff) {
    logger.info(`Poll interval: ${config.poll_minutes}m`);
  }
  logger.info(`Scripts dir: ${config.scripts_dir}`);

  let notionInitialized = false;

  const ensureNotion = async (cfg: AppConfig) => {
    if (cfg.local_mode || notionInitialized) return;

    try {
      validateNotionEnvVars();
      await initDatabaseSchema();
      logger.info("Notion database schema verified.");
      notionInitialized = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Notion initialization failed - ${errorMsg}`);
      if (isOneOff) {
        Deno.exit(1);
      }
    }
  };

  if (isOneOff) {
    // Single run
    await ensureNotion(config);
    await runCycle(config, true);
    logger.info("One-off cycle complete.");
  } else {
    // Poll loop
    logger.info("Starting poll loop...");
    logger.info("Orchestrator started (poll mode)");

    while (true) {
      // Reload config to pick up changes (e.g. poll_minutes, local_mode, history limits)
      try {
        config = await loadConfig();
      } catch (err) {
        logger.warn(
          `Failed to reload config (might be mid-edit), keeping previous settings: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      await ensureNotion(config);

      try {
        await runCycle(config, false);
      } catch (err) {
        logger.error(
          `Cycle failed - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
