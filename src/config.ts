/**
 * Configuration loader.
 * Loads from local/config.jsonc with fallback to DEFAULT_CONFIG.
 */

import { parse as parseJsonc } from "@std/jsonc";
import * as path from "@std/path";
import type { AppConfig } from "./types.ts";

const PROJECT_ROOT = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
);

export const DEFAULT_CONFIG: AppConfig = {
  // Run without Notion sync, using only local queue.json
  local_mode: false,

  // Minutes between each poll/execute cycle (minimum 1)
  poll_minutes: 15,

  // Base directory for executable scripts (relative to project root)
  scripts_dir: "scripts",

  // Maximum time in minutes a job can be overdue before it is marked as missed (0 = infinite lookback)
  lookback_minutes: 0,

  // Max age in days and max number of log files & historical jobs to keep (0 = unlimited)
  history_max_age_days: 90,
  history_max_entries: 0,

  // Emoji prefixes used in Notion title
  emojis: {
    pending: "",
    running: "⏳",
    success: "✅",
    failed: "❌",
    error: "🚫",
    disabled: "💤",
    skipped: "⏩",
    missed: "‼️",
  },

  // Display text for statuses shown in Notion
  status_text: {
    pending: "pending",
    running: "running",
    success: "success",
    failed: "failed",
    error: "error",
    disabled: "disabled",
    skipped: "skipped",
    missed: "missed",
  },

  // Mapping of file extensions (without dot) to the command array used to run them
  runtimes: {
    "ts": ["deno", "run"],
    "js": ["deno", "run"],
    "py": ["uv", "run"],
    "sh": ["bash"],
  },

  // Environment variables explicitly forwarded to subprocesses.
  // Parent process variables are otherwise cleared, aside from minimal runtime lookup vars like PATH.
  // - "default": Applied to ALL scripts.
  // - "your_script.ts": Applied ONLY to that specific script (overrides "default").
  env: {
    default: {
      // "NAME": "value",
    },
    // "your_script.ts": {
    //   "API_KEY": "secret-value",
    // },
  },

  // Custom working directory overrides for scripts.
  // Default is the directory containing the script.
  cwd: {
    // "your_script.ts": "/custom/path"
  },
};

/**
 * Load and merge config from a JSONC file.
 * @param configPath Optional path to a specific config file. Defaults to local/config.jsonc
 */
export async function loadConfig(
  configPath?: string,
): Promise<AppConfig> {
  const targetPath = configPath ??
    path.join(PROJECT_ROOT, "local", "config.jsonc");

  let overrides: Partial<AppConfig> = {};

  try {
    const text = await Deno.readTextFile(targetPath);
    overrides = parseJsonc(text) as Partial<AppConfig>;
  } catch (_error) {
    if (configPath) {
      console.warn(
        `Warning: Custom config file not found or invalid at ${configPath}. Using defaults.`,
      );
    }
    // If it's the default path and not found, we just quietly use DEFAULT_CONFIG.
  }

  const merged = { ...DEFAULT_CONFIG, ...overrides };

  // Merge nested objects like runtimes and emojis explicitly to avoid overwriting defaults
  if (overrides.runtimes) {
    merged.runtimes = { ...DEFAULT_CONFIG.runtimes, ...overrides.runtimes };
  }
  if (overrides.emojis) {
    merged.emojis = { ...DEFAULT_CONFIG.emojis, ...overrides.emojis };
  }
  if (overrides.status_text) {
    merged.status_text = {
      ...DEFAULT_CONFIG.status_text,
      ...overrides.status_text,
    };
  }
  if (overrides.env) {
    merged.env = { ...DEFAULT_CONFIG.env };
    for (const [key, val] of Object.entries(overrides.env)) {
      merged.env[key] = { ...(merged.env[key] || {}), ...val };
    }
  }
  if (overrides.cwd) {
    merged.cwd = { ...DEFAULT_CONFIG.cwd, ...overrides.cwd };
  }

  // Ensure poll_minutes is at least 1
  merged.poll_minutes = Math.max(1, merged.poll_minutes);

  // Resolve scripts_dir to absolute path
  if (!path.isAbsolute(merged.scripts_dir)) {
    merged.scripts_dir = path.resolve(PROJECT_ROOT, merged.scripts_dir);
  }

  return merged;
}

export { PROJECT_ROOT };
