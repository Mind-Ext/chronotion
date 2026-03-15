## cronotion

⏳ A task scheduler for executing local scripts using Notion database as remote UI. Intended for infrequent jobs. No more cron expressions. Only intuitive control. 

### Getting started

1. **Deno**: Install [Deno](https://deno.com/) runtime.
2. **Notion**:
   - Create an [internal integration](https://www.notion.so/profile/integrations/internal) to obtain `NOTION_API_KEY`.
   - Create an emtpy database. Go to `···` menu -> `Connections` to link your integration.
   - Find `NOTION_DATABASE_ID` from the Notion database URL like `https://www.notion.so/{workspace}/{database_id}?v={view_id}`.
   - Copy [.env-example](./.env-example) as `.env` and fill in your `NOTION_API_KEY` and `NOTION_DATABASE_ID`.
3. **Local mode** (Optional): To bypass Notion, set `"local_mode": true` in `local/config.jsonc` and manage your jobs by manually editing `local/queue.json`.
4. **Run**:
   - **Polling mode**:
     ```bash
     deno task start --poll
     ```
        Keep the orchestrator running in a loop. It will poll Notion database / local queue at a specified interval and execute due jobs.
     
        To run continously in the background, use process managers like PM2, or system services (e.g. systemd on Linux, Task Scheduler on Windows, launchd on macOS).
   - **One-off mode**:
     ```bash
     deno task start --one-off
     ```
     Execute a single cycle and exit. Ideal when using external schedulers like `cron` or system services mentioned above (as timers).
5. **Add jobs**: The first run creates the schema for your Notion database. Add your first job by creating a Notion page (or a JSON entry in `local/queue.json`).

   **Required fields**:
   - **script**: filename in `scripts/` (e.g. `backup.sh`, `sync.ts`).
   - **run_at**: scheduled time for the job (Date property in Notion, ISO 8601 format for local mode).

   **Optional fields**:
   - **next_in**: interval or macro for rescheduling. [Supported format](./src/schedule.ts) examples:
     - _Intervals_: `1 day`, `2 weeks`, `3 months`, `1 year`
     - _Macros_: `first monday of month`, `last day of month`, `2nd friday of month`, `last monday of december`
     - _None_: `never` or empty (default)
   - **args**: arguments passed to the script, space-separated or JSON array. Default empty.
   - **deno_args**: Deno runtime flags for ts / js scripts (e.g. `--allow-net`), space-separated or JSON array. Default empty.
   - **timeout_minutes**: execution timeout in minutes. Default unlimited.
   - **end_on**: expiration date / time for recurring jobs. Default no expiration.
   - **status**: leave empty, will be set to `pending` after validation.
   - **name**: human-friendly name for the job. Title of Notion page.

   **Managed fields**: (updated by the orchestrator)
   - **name**: updated with status emoji prefix.
   - **status**: updated to `pending`, `running`, `success`, `failed`, etc.
   - **uid**: auto-generated unique identifier for the job instance.
   - **prev_instance** / **next_instance**: relations linking recurring jobs.
   - **page content**: captures the stdout / stderr of the script execution.

### Configuration

Customize the orchestrator's behavior by creating `local/config.jsonc`. See [src/config.ts](./src/config.ts) for all available options and their default values.

**Key settings**:

- **local_mode**: if `true`, it bypasses Notion and uses `local/queue.json` (default: `false`).
- **poll_minutes**: how often to fetch and check for due jobs (default: `15`).
- **scripts_dir**: directory under project root for storing scripts (default: `scripts`).
- **lookback_minutes**: max age of missed jobs to still execute (default: `0` for infinite).
- **runtimes**: command mappings for file extensions (default: `deno run` for `js`/`ts`, `uv run` for `py`, `bash` for `sh`).
- **env**: environment variables to forward to scripts.
- **cwd**: custom working directories for specific scripts (default: scripts_dir setting).

### Job Status

- **pending**: Job is validated and waiting for `run_at`.
- **running**: ⏳ Script is executing.
- **success**: ✅ Script executed successfully with zero exit code.
- **failed**: ❌ Script returned non-zero exit code.
- **error**: 🚫 Job validation error (e.g. missing script, invalid schedule).
- **missed**: ‼️ Orchestrator was offline past `run_at` and lookback window.
- **disabled**: 💤 Manually set. Disables the current job and prevents the next instance being scheduled.
- **skipped**: ⏩ Manually set. Skips the current instance but schedules the next instance as normal.

### Disclaimer

This project is vibe-coded with human planning and review.
Commit message prefixes indicate the model generating the code.

<img src='https://count.lnfinite.space/repo/cronotion.svg?plus=1' width='0' height='0' />