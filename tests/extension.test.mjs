import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ROLE_CONFIGS, ROLES } from "../src/roles.ts";

test("role routes have explicit read/write capability boundaries", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /name: `agy_\$\{role\}`/);
  assert.match(source, /for \(const role of ROLES\) registerRoleTool/);
  assert.equal(ROLE_CONFIGS.scout.mode, "default");
  assert.equal(ROLE_CONFIGS.researcher.mode, "default");
  assert.equal(ROLE_CONFIGS.worker.mode, "accept-edits");
  assert.equal(ROLE_CONFIGS.delegate.mode, "accept-edits");
  assert.deepEqual(ROLE_CONFIGS.scout.model, "gemini-3.8-flash-medium");
  assert.deepEqual(ROLE_CONFIGS.scout.reasoningTier, "medium");
  assert.deepEqual(ROLE_CONFIGS.researcher.model, "gemini-3.8-flash-high");
  assert.deepEqual(ROLE_CONFIGS.researcher.reasoningTier, "high");
  assert.deepEqual(ROLE_CONFIGS.worker.model, "gemini-3.8-flash-high");
  assert.deepEqual(ROLE_CONFIGS.worker.reasoningTier, "high");
  assert.deepEqual(ROLE_CONFIGS.delegate.model, "gemini-3.8-flash-medium");
  assert.deepEqual(ROLE_CONFIGS.delegate.reasoningTier, "medium");
  assert.deepEqual(ROLE_CONFIGS.scout.tools.includes("replace_file_content"), false);
  assert.deepEqual(ROLE_CONFIGS.researcher.tools, ["search_web", "read_url_content"]);
  assert.deepEqual(ROLE_CONFIGS.researcher.tools.includes("replace_file_content"), false);
  assert.equal(ROLE_CONFIGS.worker.tools.includes("ask_question"), false);
  assert.equal(ROLE_CONFIGS.delegate.tools.includes("ask_question"), false);
  assert.equal(ROLE_CONFIGS.worker.tools.includes("replace_file_content"), true);
  assert.equal(ROLE_CONFIGS.delegate.tools.includes("replace_file_content"), true);
  assert.match(source, /authorizeWriteRole\(role, \{ cwd, task, context, files \}/);
  assert.match(source, /authorizeResearchContext/);
  assert.match(source, /agy_researcher does not accept file hints/);
  assert.match(source, /validateCwd/);
  assert.match(source, /model: ROLE_CONFIGS\[role\]\.model/);
  assert.doesNotMatch(source, /model:\s*params\.model/);
  const runner = await readFile(new URL("../src/runner.ts", import.meta.url), "utf8");
  assert.match(runner, /output-format/);
});

test("plugin definitions use documented tools and forbid nested delegation", async () => {
  const allowed = new Set([
    "list_dir", "find_by_name", "grep_search", "view_file", "write_to_file", "replace_file_content",
    "multi_replace_file_content", "run_command", "search_web", "read_url_content",
  ]);
  for (const role of ROLES) {
    const text = await readFile(new URL(`../agy-plugin/agents/${role}.md`, import.meta.url), "utf8");
    const tools = [...text.matchAll(/^  - ([a-z_]+)$/gm)].map((match) => match[1]);
    assert.ok(tools.length > 0, `${role} has no tools`);
    for (const tool of tools) assert.ok(allowed.has(tool), `${role} uses undocumented tool ${tool}`);
    assert.equal(tools.includes("ask_question"), false);
    assert.equal(tools.some((tool) => ["invoke_subagent", "define_subagent", "send_message", "manage_subagents"].includes(tool)), false);
    assert.match(text, /^inheritCustomizations: false$/m);
  }
  const researcher = await readFile(new URL("../agy-plugin/agents/researcher.md", import.meta.url), "utf8");
  assert.match(researcher, /^tools:\n  - search_web\n  - read_url_content$/m);
  assert.match(researcher, /# Research strategy/);
  assert.match(researcher, /## Gaps and next steps/);
});
