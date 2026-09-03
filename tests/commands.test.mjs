import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRolePrompt } from "../src/commands.ts";
import { MAX_COMMAND_ARGS_CHARS, boundCommandArgs } from "../src/schemas.ts";

test("buildRolePrompt frames each role deterministically", () => {
  assert.match(buildRolePrompt("scout", "find entry points"), /^Use the agy_scout tool for the following read-only local reconnaissance task\. Do not modify anything\. Report findings and risks\.\n\nTASK:\nfind entry points$/);
  assert.match(buildRolePrompt("researcher", "headless docs"), /^Use the agy_researcher tool to research the following question with cited sources\. Read-only; do not modify files\.\n\nTASK:\nheadless docs$/);
  assert.match(buildRolePrompt("worker", "fix the bug"), /^Use the agy_worker tool to implement the following task\. Expect a confirmation gate for writes\.\n\nTASK:\nfix the bug$/);
  assert.match(buildRolePrompt("delegate", "summarize"), /^Use the agy_delegate tool for the following bounded task\.\n\nTASK:\nsummarize$/);
});

test("boundCommandArgs keeps short args intact", () => {
  assert.equal(boundCommandArgs("hello"), "hello");
  assert.equal(boundCommandArgs(""), "");
});

test("boundCommandArgs truncates oversize args UTF-8-safely with a notice", () => {
  const multibyte = "🙂".repeat(5_000); // ~20KB UTF-8, 5k code points
  const bounded = boundCommandArgs(multibyte);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= MAX_COMMAND_ARGS_CHARS);
  assert.match(bounded, /\[arguments truncated at 8000 characters\]$/);
  // No partial surrogate pairs: decode round-trip must not throw.
  JSON.parse(JSON.stringify({ text: bounded }));

  const lines = Array.from({ length: 9_000 }, (_, i) => `line-${i}`).join("\n");
  const boundedLines = boundCommandArgs(lines);
  assert.ok(Buffer.byteLength(boundedLines, "utf8") <= MAX_COMMAND_ARGS_CHARS);
  assert.match(boundedLines, /\[arguments truncated at 8000 characters\]$/);
});

test("buildRolePrompt bounds oversized args and stays valid JSON", () => {
  const prompt = buildRolePrompt("scout", "x".repeat(20_000));
  assert.ok(prompt.length < 20_000);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= MAX_COMMAND_ARGS_CHARS + 200);
  assert.match(prompt, /\[arguments truncated at 8000 characters\]$/);
  JSON.parse(JSON.stringify({ prompt }));
});
