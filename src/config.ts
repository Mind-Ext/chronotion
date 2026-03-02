/**
 * Configuration loader.
 * Loads from local/config.jsonc with fallback to local/default_config.jsonc.
 */

import { parse as parseJsonc } from "@std/jsonc";
import * as path from "@std/path";
import type { AppConfig } from "./types.ts";

const PROJECT_ROOT = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
);

const DEFAULT_CONFIG: AppConfig = {
  local_mode: true,
  oneoff_mode: false,
  poll_minutes: 15,
  scripts_dir: "scripts",
  log_max_age_days: 30,
  log_max_entries: 0,
};

/** Load and merge config from JSONC files */
export async function loadConfig(): Promise<AppConfig> {
  const defaults = await loadJsoncFile(
    path.join(PROJECT_ROOT, "local", "config_default.jsonc"),
  );
  const overrides = await loadJsoncFile(
    path.join(PROJECT_ROOT, "local", "config.jsonc"),
  );

  const merged = { ...DEFAULT_CONFIG, ...defaults, ...overrides };

  // Ensure poll_minutes is at least 1
  merged.poll_minutes = Math.max(1, merged.poll_minutes);

  // Resolve scripts_dir to absolute path
  if (!path.isAbsolute(merged.scripts_dir)) {
    merged.scripts_dir = path.resolve(PROJECT_ROOT, merged.scripts_dir);
  }

  return merged;
}

async function loadJsoncFile(
  filePath: string,
): Promise<Partial<AppConfig>> {
  try {
    const text = await Deno.readTextFile(filePath);
    return parseJsonc(text) as Partial<AppConfig>;
  } catch {
    return {};
  }
}

export { PROJECT_ROOT };
