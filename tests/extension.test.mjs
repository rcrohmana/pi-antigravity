import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ROLE_CHAINING_GUIDE, ROLE_CONFIGS, ROLES } from "../src/roles.ts";

test("role routes have explicit read/write capability boundaries", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const roleSource = await readFile(new URL("../src/execute-role.ts", import.meta.url), "utf8");
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
  // A-07: the execution path lives in src/execute-role.ts; index.ts only wires it.
  assert.match(source, /import \{ executeRole, roleParameters, type RoleParameters \} from "\.\/src\/execute-role\.ts"/);
  assert.match(source, /return executeRole\(role, params, signal, onUpdate, ctx\);/);
  assert.doesNotMatch(source, /authorizeWriteRole|runAgyWithDenialRetry|loadAllowedCommands|preflightCwdCoverage/);
  assert.match(roleSource, /authorizeWriteRole\(role, \{ cwd, task, context, files, allowedCommands: [^}]*writeCoverage \}/);
  assert.match(roleSource, /authorizeResearchContext/);
  assert.match(roleSource, /const loadCommands = deps\.loadAllowedCommands \?\? loadAllowedCommands;/);
  assert.match(roleSource, /allowedCommands: /);
  assert.match(roleSource, /ROLE_CONFIGS\[role\]\.readOnly \? undefined : await loadCommands\(\)/);
  assert.match(roleSource, /Agy settings notice/);
  assert.match(roleSource, /agy_researcher does not accept file hints/);
  assert.match(roleSource, /validateCwd/);
  // A-05: hints are validated against the resolved cwd, so cwd must be known first.
  assert.match(roleSource, /const cwd = await validateCwd\(params\.cwd, ctx\.cwd, \[ctx\.cwd\]\);\r?\n  const files = validateFileHints\(params\.files, cwd\);/);
  assert.match(roleSource, /model: ROLE_CONFIGS\[role\]\.model/);
  assert.doesNotMatch(roleSource, /model:\s*params\.model/);
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
  assert.match(researcher, /^tools:\r?\n  - search_web\r?\n  - read_url_content\r?$/m);
  assert.match(researcher, /# Research strategy/);
  assert.match(researcher, /## Gaps and next steps/);
});

test("role routing guidance covers cross-role boundaries and chaining", async () => {
  for (const role of ROLES) {
    assert.ok(
      typeof ROLE_CONFIGS[role].boundary === "string" && ROLE_CONFIGS[role].boundary.length > 0,
      `${role} config is missing a non-empty boundary`,
    );
  }
  assert.match(ROLE_CONFIGS.researcher.boundary, /No local file/);
  assert.match(ROLE_CONFIGS.worker.boundary, /No web/);
  assert.match(ROLE_CHAINING_GUIDE, /agy_researcher/);
  assert.match(ROLE_CHAINING_GUIDE, /agy_worker/);

  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const roleSource = await readFile(new URL("../src/execute-role.ts", import.meta.url), "utf8");
  assert.match(source, /boundary/);
  assert.match(source, /ROLE_CHAINING_GUIDE/);

  const skillChecks = {
    "agy-researcher": /Never put file-edit instructions in the researcher task/,
    "agy-worker": /worker cannot browse/,
    "agy-delegate": /delegate cannot browse/,
    "agy-scout": /No web; for documentation lookups use `agy_researcher`/,
  };
  for (const [dir, pattern] of Object.entries(skillChecks)) {
    const skill = await readFile(new URL(`../skills/${dir}/SKILL.md`, import.meta.url), "utf8");
    assert.match(skill, pattern, `${dir}: missing chaining/do-not-use rule`);
  }
});

test("role tools run through the bounded denial auto-retry with an opt-out parameter", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const roleSource = await readFile(new URL("../src/execute-role.ts", import.meta.url), "utf8");
  assert.match(roleSource, /import \{ runAgyWithDenialRetry \} from "\.\/retry\.ts"/);
  assert.match(roleSource, /const runRole = deps\.runRole \?\? runAgyWithDenialRetry;/);
  assert.match(roleSource, /await runRole\(\{/);
  assert.match(roleSource, /autoRetry: params\.auto_retry !== false/);
  assert.match(roleSource, /auto_retry: Type\.Optional\(/);
  assert.doesNotMatch(source, /\brunAgy\(\{/);
  assert.doesNotMatch(roleSource, /\brunAgy\(\{/);
  const retry = await readFile(new URL("../src/retry.ts", import.meta.url), "utf8");
  assert.match(retry, /export const MAX_DENIAL_RETRIES = 1;/);
  assert.doesNotMatch(retry, /dangerously/);
});

test("composite research-apply and doctor tools are registered with a cwd preflight on role tools", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const roleSource = await readFile(new URL("../src/execute-role.ts", import.meta.url), "utf8");
  assert.match(source, /name: "agy_research_apply"/);
  assert.match(source, /executeResearchApply\(params, signal, onUpdate, ctx,/);
  assert.match(source, /executeRole\(role, legParams, legSignal, legUpdate, legCtx, internal\)/);
  assert.match(roleSource, /internal: ExecuteRoleInternal = \{\}/);
  assert.match(roleSource, /skipWriteGate\?: boolean;\s*\/\*\*[^*]*\*\/\s*progressLabel\?: string;/);
  assert.match(roleSource, /internal\.skipWriteGate && ctx\.hasUI/);
  assert.match(source, /name: "agy_doctor"/);
  assert.match(source, /runAgyDoctor\(\{ cwd \}\)/);
  assert.match(roleSource, /const preflight = deps\.preflightCwdCoverage \?\? preflightCwdCoverage;/);
  assert.match(roleSource, /await preflight\(\{ cwd \}\)/);
  assert.match(roleSource, /skip_preflight: Type\.Optional\(/);
  assert.match(roleSource, /role !== "researcher" && !conversationId && !params\.skip_preflight/);
  assert.match(source, /registerResearchApplyTool\(pi\);\s*registerDoctorTool\(pi\);/);
  const commands = await readFile(new URL("../src/commands.ts", import.meta.url), "utf8");
  assert.match(commands, /registerCommand\("agy_research_apply"/);
  assert.match(commands, /registerCommand\("agy_doctor"/);
  const skill = await readFile(new URL("../skills/agy-research-apply/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^name: agy-research-apply$/m);
  assert.match(skill, /agy_research_apply/);
});

test("every role carries a graceful-degradation paragraph that reaches the Agy prompt and the plugin rules", async () => {
  for (const role of ROLES) {
    const text = ROLE_CONFIGS[role].degradation;
    assert.match(text, /^Role limits \(fixed, not negotiable\):/, role);
    assert.match(text, /Decisions needed|Proposed changes/, role);
  }
  assert.match(ROLE_CONFIGS.researcher.degradation, /cannot read, list, create, or edit workspace files/);
  assert.match(ROLE_CONFIGS.researcher.degradation, /Proposed changes/);
  assert.match(ROLE_CONFIGS.worker.degradation, /never invent citations, URLs, or facts/);
  assert.match(ROLE_CONFIGS.delegate.degradation, /never invent citations, URLs, or facts/);
  assert.match(ROLE_CONFIGS.scout.degradation, /agy_researcher for web sources, agy_worker for edits or commands/);
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const roleSource = await readFile(new URL("../src/execute-role.ts", import.meta.url), "utf8");
  assert.match(roleSource, /roleLimits: ROLE_CONFIGS\[role\]\.degradation/);
  const runner = await readFile(new URL("../src/runner.ts", import.meta.url), "utf8");
  assert.match(runner, /roleLimits: options\.roleLimits/);
  const plugin = async (role) => readFile(new URL(`../agy-plugin/agents/${role}.md`, import.meta.url), "utf8");
  assert.match(await plugin("scout"), /^5\. You have no web, write, or command tools\./m);
  assert.match(await plugin("researcher"), /^5\. You have no file or command tools\..*Never claim to have read or written a file\./m);
  assert.match(await plugin("worker"), /^6\. You have no web tools\. Never invent citations/m);
  assert.match(await plugin("delegate"), /^6\. You have no web tools\. Never invent citations/m);
});

// ---- A-12: ROLE_CONFIGS must mirror the installed plugin frontmatter ----

test("each plugin agent's frontmatter mirrors ROLE_CONFIGS (tools, command policy, inherited model)", async () => {
  const { ROLE_CONFIGS, ROLES } = await import("../src/roles.ts");
  for (const role of ROLES) {
    const text = await readFile(new URL(`../agy-plugin/agents/${role}.md`, import.meta.url), "utf8");
    const frontmatter = text.split(/^---\r?\n/m)[1];
    assert.ok(frontmatter, `${role}: missing frontmatter`);
    const tools = [...frontmatter.matchAll(/^  - ([a-z_]+)$/gm)].map((match) => match[1]);
    assert.deepEqual([...tools].sort(), [...ROLE_CONFIGS[role].tools].sort(), `${role}: plugin tools drifted from ROLE_CONFIGS.tools`);
    const policy = frontmatter.match(/^commandExecutionPolicy: (\S+)$/m)?.[1];
    assert.equal(policy, ROLE_CONFIGS[role].commandExecutionPolicy, `${role}: commandExecutionPolicy drifted`);
    // The runner passes --model from ROLE_CONFIGS; the plugin must not pin its own.
    assert.equal(frontmatter.match(/^model: (\S+)$/m)?.[1], "inherit", `${role}: plugin must inherit the model chosen by the runner`);
    assert.equal(frontmatter.match(/^name: (\S+)$/m)?.[1], ROLE_CONFIGS[role].agent);
  }
});
