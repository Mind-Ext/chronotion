/**
 * CLI for immediately ingesting read-only external entries into Notion.
 *
 * Accepts a JSON string as an argument or reads JSON from stdin, runs the exact
 * same validation path as `local/inbox/`, and pushes directly to Notion without
 * touching `app.lock` or `local/queue.json`.
 *
 * Pass `--queue` to write to `local/inbox/` for the daemon to push on its next
 * poll cycle instead of pushing immediately.
 *
 * Usage:
 *   deno task ingest '{"name":"backup","worker_id":"oracle-systemd","status":"success"}'
 *   echo '{"name":"backup","status":"failed","output":"exit 1"}' | deno task ingest
 */

import { load as loadEnv } from "@std/dotenv";
import * as path from "@std/path";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import { parseInboxJson, writeInboxEntry } from "./inbox.ts";
import { createNotionInboxEntry } from "./notion.ts";

const USAGE = `Usage:
  deno task ingest [--queue] '<json>'
  echo '<json>' | deno task ingest [--queue]

Options:
  --queue       Write to local/inbox/ for the daemon instead of pushing immediately
  -h, --help    Show this help message

Accepts a JSON object (or array of objects) with fields:
  name          string   (required unless script is set)
  status        string   (required: success | failed | error | missed)
  worker_id     string   (optional, default: "external")
  script        string   (optional, default: "")
  args          string[] (optional, default: [])
  scheduled_at  string   (optional ISO-8601, default: finished_at or now)
  finished_at   string   (optional ISO-8601)
  output        string   (optional)
  uid           string   (optional, default: random UUID)
`;

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk);
  }
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function main(): Promise<void> {
  const args = Deno.args;

  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    Deno.exit(0);
  }

  let queueOnly = false;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--queue") {
      queueOnly = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      console.error(`Error: Unknown option '${arg}'.\n`);
      console.error(USAGE);
      Deno.exit(1);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    console.error("Error: Expected at most one JSON argument.\n");
    console.error(USAGE);
    Deno.exit(1);
  }

  let rawJson: string;
  if (positional.length === 1 && positional[0] !== "-") {
    rawJson = positional[0];
  } else if (!Deno.stdin.isTerminal()) {
    rawJson = await readStdin();
  } else {
    console.error(
      "Error: Provide a JSON string argument or pipe JSON to stdin.\n",
    );
    console.error(USAGE);
    Deno.exit(1);
  }

  try {
    const entries = parseInboxJson(rawJson);

    if (queueOnly) {
      for (const entry of entries) {
        const writtenPath = await writeInboxEntry(entry);
        console.log(writtenPath);
      }
      return;
    }

    // Load .env relative to PROJECT_ROOT so invoking from any cwd works
    try {
      await loadEnv({
        envPath: path.join(PROJECT_ROOT, ".env"),
        export: true,
      });
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }

    const config = await loadConfig();
    if (config.local_mode) {
      throw new Error(
        "local_mode is enabled; use --queue or disable local_mode to push directly to Notion.",
      );
    }

    const apiKey = config.notion_api_key || Deno.env.get("NOTION_API_KEY");
    const databaseId = config.notion_database_id ||
      Deno.env.get("NOTION_DATABASE_ID") ||
      Deno.env.get("NOTION_TEST_DATABASE_ID");
    if (!apiKey || !databaseId) {
      const missing: string[] = [];
      if (!apiKey) missing.push("notion_api_key (or NOTION_API_KEY env)");
      if (!databaseId) {
        missing.push("notion_database_id (or NOTION_DATABASE_ID env)");
      }
      throw new Error(
        `Missing required Notion credentials: ${missing.join(", ")}`,
      );
    }

    for (const entry of entries) {
      const pageId = await createNotionInboxEntry(entry, config);
      console.log(pageId);
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
