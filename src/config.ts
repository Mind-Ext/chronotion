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
  local_mode: true,
  oneoff_mode: false,
  poll_minutes: 15,
  scripts_dir: "scripts",
  log_max_age_days: 30,
  log_max_entries: 0,
  emojis: {
    pending: "",
    running: "⏳",
    success: "✅",
    failed: "❌",
    error: "‼️",
    disabled: "🚫",
    skipped: "⏩",
  },
  status_text: {
    pending: "pending",
    running: "running",
    success: "success",
    failed: "failed",
    error: "error",
    disabled: "disabled",
    skipped: "skipped",
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

  // Ensure poll_minutes is at least 1
  merged.poll_minutes = Math.max(1, merged.poll_minutes);

  // Resolve scripts_dir to absolute path
  if (!path.isAbsolute(merged.scripts_dir)) {
    merged.scripts_dir = path.resolve(PROJECT_ROOT, merged.scripts_dir);
  }

  return merged;
}

export { PROJECT_ROOT };
