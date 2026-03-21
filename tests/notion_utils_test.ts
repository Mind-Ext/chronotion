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
  parseStringArgs,
  richText,
  truncateOutput,
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
