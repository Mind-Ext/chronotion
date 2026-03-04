import { assertEquals } from "@std/assert";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import * as path from "@std/path";

Deno.test("loadConfig returns valid default config when no file exists", async () => {
  // Pass a path that definitely doesn't exist so we only get defaults
  const config = await loadConfig("/does/not/exist/config.jsonc");

  assertEquals(config.local_mode, DEFAULT_CONFIG.local_mode);
  assertEquals(config.oneoff_mode, DEFAULT_CONFIG.oneoff_mode);
  assertEquals(config.poll_minutes, DEFAULT_CONFIG.poll_minutes);

  // scripts_dir should be resolved to absolute
  assertEquals(config.scripts_dir.startsWith("/"), true);
  assertEquals(path.basename(config.scripts_dir), "scripts");

  // check new mappings
  assertEquals(config.emojis.success, "✅");
  assertEquals(config.status_text.running, "running");
});
