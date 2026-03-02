import { assertEquals } from "@std/assert";
import { loadConfig } from "./config.ts";

Deno.test("loadConfig returns valid config", async () => {
  const config = await loadConfig();
  assertEquals(config.local_mode, true);
  assertEquals(typeof config.oneoff_mode, "boolean");
  assertEquals(typeof config.poll_minutes, "number");
  assertEquals(config.poll_minutes >= 1, true);
  assertEquals(typeof config.scripts_dir, "string");
  // scripts_dir should be resolved to absolute
  assertEquals(config.scripts_dir.startsWith("/"), true);
});
