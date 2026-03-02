/**
 * Core data types for Chronotion.
 */

export const JOB_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "error",
  "disabled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobInstance {
  /** Unique identifier (hash of script + args + creation timestamp) */
  uid: string;
  /** Script filename relative to scripts/ directory */
  script: string;
  /** JSON array of arguments to pass to the script */
  args: string[];
  /** Deno-specific permission flags (--allow/deny/unstable only) */
  deno_args: string[];
  /** ISO-8601 timestamp for when this job should run */
  run_at: string;
  /** Interval or macro for rescheduling (e.g. "1d", "first monday of month", "never") */
  next_in: string;
  /** Current execution status */
  status: JobStatus;
  /** UID of the previous instance (for chaining) */
  prev_instance: string | null;
  /** Captured stdout/stderr output */
  output: string;
  /** Optional timeout in minutes */
  timeout_minutes: number | null;
  /** ISO-8601 timestamp of when this instance was created */
  created_at: string;
}

export interface AppConfig {
  /** If true, Notion sync is disabled */
  local_mode: boolean;
  /** If true, run once and terminate */
  oneoff_mode: boolean;
  /** Minutes between each poll loop (minimum 1) */
  poll_minutes: number;
  /** Base directory for scripts (resolved to absolute) */
  scripts_dir: string;
  /** Log cleanup: max age in days (0 = no cleanup) */
  log_max_age_days: number;
  /** Log cleanup: max number of log files (0 = no limit) */
  log_max_entries: number;
}

/** Queue file structure */
export interface QueueData {
  jobs: JobInstance[];
  last_updated: string;
}
