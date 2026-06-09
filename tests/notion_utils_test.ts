/**
 * Unit tests for Notion utility functions.
 * These tests are pure and do not require the Notion API.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getDateString,
  getNumberValue,
  getPlainText,
  getRelationId,
  getSelectValue,
  parseDate,
  parseNotionDateString,
  parseStringArgs,
  richText,
  truncateOutput,
  validateNotionEnvVars,
} from "../src/notion_utils.ts";

// ─── Truncation Tests ───────────────────────────────────────────────

Deno.test("truncateOutput: short strings pass through unchanged", () => {
  const input = "Hello, world!";
  assertEquals(truncateOutput(input), input);
});

Deno.test("truncateOutput: exactly 2000 chars pass through", () => {
  const input = "x".repeat(2000);
  assertEquals(truncateOutput(input), input);
});

Deno.test("truncateOutput: 2001 chars get truncated", () => {
  const input = "a".repeat(2001);
  const result = truncateOutput(input);
  assert(result.length <= 2000);
  assert(result.startsWith("[..."));
  assert(result.includes("characters truncated"));
});

Deno.test("truncateOutput: large output keeps last 1950 chars", () => {
  const prefix = "A".repeat(5000);
  const suffix = "B".repeat(1950);
  const input = prefix + suffix;
  const result = truncateOutput(input);
  assert(result.endsWith(suffix));
  assert(result.length <= 2000);
});

// ─── Argument Parsing Tests ──────────────────────────────────────────

Deno.test("parseStringArgs: handles empty string", () => {
  assertEquals(parseStringArgs(""), []);
});

Deno.test("parseStringArgs: handles JSON array", () => {
  assertEquals(parseStringArgs('["--foo", "bar"]'), ["--foo", "bar"]);
});

Deno.test("parseStringArgs: handles simple space-separated strings", () => {
  assertEquals(parseStringArgs("--foo bar"), ["--foo", "bar"]);
});

Deno.test("parseStringArgs: handles invalid JSON by falling back", () => {
  assertEquals(parseStringArgs('["incomplete"'), ['["incomplete"']);
});

// ─── Property Extraction Tests ───────────────────────────────────────

Deno.test("getPlainText: extracts from title", () => {
  const prop = {
    type: "title" as const,
    title: [{ plain_text: "Hello" }, { plain_text: " World" }],
  };
  assertEquals(getPlainText(prop), "Hello World");
});

Deno.test("getPlainText: extracts from rich_text", () => {
  const prop = {
    type: "rich_text" as const,
    rich_text: [{ plain_text: "Foo" }],
  };
  assertEquals(getPlainText(prop), "Foo");
});

Deno.test("getDateString: extracts ISO date", () => {
  const prop = {
    type: "date" as const,
    date: { start: "2023-01-01T12:00:00Z" },
  };
  assertEquals(getDateString(prop), "2023-01-01T12:00:00.000Z");
});

Deno.test("getDateString: preserves date-only strings", () => {
  const prop = {
    type: "date" as const,
    date: { start: "2023-01-01" },
  };
  assertEquals(getDateString(prop), "2023-01-01");
});

Deno.test("getDateString: preserves timezone and offset", () => {
  // Test with named timezone
  const prop1 = {
    type: "date" as const,
    date: { start: "2026-06-08T00:55:00.000-04:00", time_zone: "America/New_York" },
  };
  assertEquals(getDateString(prop1), "2026-06-08T00:55:00-04:00[America/New_York]");

  // Test with offset only
  const prop2 = {
    type: "date" as const,
    date: { start: "2026-06-08T00:55:00.000-04:00", time_zone: null },
  };
  assertEquals(getDateString(prop2), "2026-06-08T00:55:00-04:00[-04:00]");

  // Test with defaultTimeZone (matching offset)
  assertEquals(
    getDateString(prop2, "America/New_York"),
    "2026-06-08T00:55:00-04:00[America/New_York]",
  );

  // Test with defaultTimeZone (mismatching offset)
  assertEquals(
    getDateString(prop2, "Asia/Shanghai"),
    "2026-06-08T00:55:00-04:00[-04:00]",
  );

  // Test with winter date (matching standard time offset -05:00)
  const propWinter = {
    type: "date" as const,
    date: { start: "2026-12-08T00:55:00.000-05:00", time_zone: null },
  };
  assertEquals(
    getDateString(propWinter, "America/New_York"),
    "2026-12-08T00:55:00-05:00[America/New_York]",
  );

  // Test with UTC / Z (should normalize to .toISOString() standard format)
  const prop3 = {
    type: "date" as const,
    date: { start: "2026-06-08T00:55:00.000Z", time_zone: null },
  };
  assertEquals(getDateString(prop3), "2026-06-08T00:55:00.000Z");
});

Deno.test("parseDate: strips timezone bracket suffix", () => {
  const d = parseDate("2026-06-08T00:55:00-04:00[America/New_York]");
  assertEquals(d.getTime(), new Date("2026-06-08T00:55:00-04:00").getTime());
});

Deno.test("parseNotionDateString: extracts start and time_zone", () => {
  // Named timezone
  const res1 = parseNotionDateString("2026-06-08T00:55:00-04:00[America/New_York]");
  assertEquals(res1, { start: "2026-06-08T00:55:00-04:00", time_zone: "America/New_York" });

  // Offset only timezone
  const res2 = parseNotionDateString("2026-06-08T00:55:00-04:00[-04:00]");
  assertEquals(res2, { start: "2026-06-08T00:55:00-04:00", time_zone: null });

  // UTC / no brackets
  const res3 = parseNotionDateString("2026-06-08T00:55:00.000Z");
  assertEquals(res3, { start: "2026-06-08T00:55:00.000Z", time_zone: null });
});

Deno.test("getSelectValue: extracts name", () => {
  const prop = {
    type: "select" as const,
    select: { name: "pending" },
  };
  assertEquals(getSelectValue(prop), "pending");
});

Deno.test("getNumberValue: extracts number", () => {
  const prop = {
    type: "number" as const,
    number: 42,
  };
  assertEquals(getNumberValue(prop), 42);
});

Deno.test("getRelationId: extracts first ID", () => {
  const prop = {
    type: "relation" as const,
    relation: [{ id: "id1" }, { id: "id2" }],
  };
  assertEquals(getRelationId(prop), "id1");
});

// ─── Push Logic Tests ───────────────────────────────────────────────

Deno.test("richText: builds array", () => {
  assertEquals(richText("Hello"), [{
    type: "text",
    text: { content: "Hello" },
  }]);
});

// ─── Env Var Validation Tests ───────────────────────────────────────

Deno.test("validateNotionEnvVars: reads credentials from config if provided", () => {
  const mockConfig = {
    notion_api_key: "cfg-api-key",
    notion_database_id: "cfg-db-id",
  };

  // deno-lint-ignore no-explicit-any
  const creds = validateNotionEnvVars(mockConfig as any);
  assertEquals(creds.apiKey, "cfg-api-key");
  assertEquals(creds.databaseId, "cfg-db-id");
});

Deno.test("validateNotionEnvVars: falls back to environment variables", () => {
  const originalApiKey = Deno.env.get("NOTION_API_KEY");
  const originalDbId = Deno.env.get("NOTION_DATABASE_ID");

  try {
    Deno.env.set("NOTION_API_KEY", "env-api-key");
    Deno.env.set("NOTION_DATABASE_ID", "env-db-id");

    const creds = validateNotionEnvVars();
    assertEquals(creds.apiKey, "env-api-key");
    assertEquals(creds.databaseId, "env-db-id");
  } finally {
    if (originalApiKey) Deno.env.set("NOTION_API_KEY", originalApiKey);
    else Deno.env.delete("NOTION_API_KEY");

    if (originalDbId) Deno.env.set("NOTION_DATABASE_ID", originalDbId);
    else Deno.env.delete("NOTION_DATABASE_ID");
  }
});
