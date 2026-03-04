/**
 * Execution engine with security model.
 *
 * - Path jail: scripts must resolve within the scripts directory
 * - Runtime detection: .ts/.js -> deno, .py -> uv run, .sh -> bash
 * - Shell-less execution: shell: false for all subprocesses
 * - POSIX shield: "--" before user arguments
 * - Timeout support via AbortController
 */

import * as path from "@std/path";
import type { AppConfig, JobInstance } from "./types.ts";

const ALLOWED_DENO_ARG_PREFIXES = ["--allow-", "--deny-", "--unstable"];

/** Detect runtime command from file extension */
export function detectRuntimeCommand(
  script: string,
  runtimes: Record<string, string[]>,
): string[] | null {
  const ext = path.extname(script).toLowerCase().replace(/^\./, "");
  return runtimes[ext] || null;
}

/** Validate that a script path resolves within the scripts directory (path jail) */
export function validateScriptPath(
  scriptRelative: string,
  scriptsDir: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
  // Resolve the full path
  const resolved = path.resolve(scriptsDir, scriptRelative);

  // Ensure it's within the scripts directory
  const normalizedBase = path.resolve(scriptsDir) + path.SEPARATOR;
  if (
    !resolved.startsWith(normalizedBase) &&
    resolved !== path.resolve(scriptsDir)
  ) {
    return {
      ok: false,
      error: `Script path "${scriptRelative}" escapes the scripts directory`,
    };
  }

  return { ok: true, resolved };
}

/** Filter deno_args to only allow safe permission flags */
export function sanitizeDenoArgs(args: string[]): string[] {
  return args.filter((arg) =>
    ALLOWED_DENO_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

/** Build the command array for a job */
export function buildCommand(
  job: JobInstance,
  scriptPath: string,
  baseCmd: string[],
): string[] {
  // Special case for deno run: inject deno_args
  if (baseCmd.length >= 2 && baseCmd[0] === "deno" && baseCmd[1] === "run") {
    const denoArgs = sanitizeDenoArgs(job.deno_args);
    // Combine base command (which might include global flags), instance args, then script and user args
    return [...baseCmd, ...denoArgs, "--", scriptPath, ...job.args];
  }

  // Generic case for all other runtimes
  const cmd = [...baseCmd, scriptPath];
  if (job.args.length > 0) {
    cmd.push("--", ...job.args);
  }
  return cmd;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  exitCode: number;
}

/** Execute a job's script as a subprocess */
export async function executeScript(
  job: JobInstance,
  config: AppConfig,
): Promise<ExecutionResult> {
  // Validate path jail
  const pathResult = validateScriptPath(job.script, config.scripts_dir);
  if (!pathResult.ok) {
    return { success: false, output: pathResult.error, exitCode: -1 };
  }

  // Check script exists
  try {
    await Deno.stat(pathResult.resolved);
  } catch {
    return {
      success: false,
      output: `Script not found: ${pathResult.resolved}`,
      exitCode: -1,
    };
  }

  // Detect runtime
  const baseCmd = detectRuntimeCommand(job.script, config.runtimes);
  if (!baseCmd) {
    return {
      success: false,
      output:
        `Unsupported script type: ${job.script}. Check runtimes in config.`,
      exitCode: -1,
    };
  }

  // Build command
  const cmdArray = buildCommand(job, pathResult.resolved, baseCmd);

  // Set up abort controller for timeout
  const ac = job.timeout_minutes ? new AbortController() : null;

  const timeoutId = ac && job.timeout_minutes
    ? setTimeout(() => ac.abort(), job.timeout_minutes * 60 * 1000)
    : null;

  try {
    const cmd = new Deno.Command(cmdArray[0], {
      args: cmdArray.slice(1),
      stdout: "piped",
      stderr: "piped",
      signal: ac?.signal,
    });

    const process = cmd.spawn();
    const result = await process.output();

    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    const output = (stdout + (stderr ? "\n--- stderr ---\n" + stderr : ""))
      .trim();

    return {
      success: result.code === 0,
      output,
      exitCode: result.code,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        success: false,
        output: `Script timed out after ${job.timeout_minutes} minutes`,
        exitCode: -1,
      };
    }
    return {
      success: false,
      output: `Execution error: ${
        err instanceof Error ? err.message : String(err)
      }`,
      exitCode: -1,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
