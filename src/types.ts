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
  "skipped",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobInstance {
  /** Unique identifier (hash of script + args + creation timestamp) */
  uid: string;
  /** Optional human-readable name for the job (used as Notion Title) */
  name?: string;
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
  /** ISO-8601 timestamp when this recurring job should stop spawning new instances */
  end_on: string | null;
  /** UID of the previous instance (for chaining) */
  prev_instance: string | null;
  /** UID of the next instance, populated when the next job is scheduled */
  next_instance: string | null;
  /** Captured stdout/stderr output */
  output: string;
  /** Notion page ID for remote sync (undefined in local-only mode) */
  notion_page_id?: string;
  /** Optional timeout in minutes */
  timeout_minutes: number | null;
  /** ISO-8601 timestamp of when this instance was created */
  created_at: string;
}

export interface AppConfig {
  /** If true, Notion sync is disabled */
  local_mode: boolean;
  /** Minutes between each poll loop (minimum 1) */
  poll_minutes: number;
  /** Base directory for scripts (resolved to absolute) */
  scripts_dir: string;
  /** Log and Queue cleanup: max age in days (0 = no limit) */
  history_max_age_days: number;
  /** Log and Queue cleanup: max number of log files/jobs (0 = no limit) */
  history_max_entries: number;
  /** Emoji prefixes for status in Notion */
  emojis: Record<JobStatus, string>;
  /** Status display text in Notion */
  status_text: Record<JobStatus, string>;
  /** Mapping of file extensions (without dot) to the command array used to run them. Example: { "py": ["uv", "run"] } */
  runtimes: Record<string, string[]>;
  /** Environment variables explicitly forwarded to subprocesses. Key 'default' applies to all scripts. */
  env: Record<string, Record<string, string>>;
}

/** Queue file structure */
export interface QueueData {
  jobs: JobInstance[];
  last_updated: string;
}
