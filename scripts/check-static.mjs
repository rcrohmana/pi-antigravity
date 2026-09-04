import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "agy-plugin", "plugin.json"), "utf8"));
assert.match(manifest.name, /^[a-zA-Z0-9-_]+$/);
assert.equal(typeof manifest.description, "string");

const requiredRoles = ["worker", "scout", "delegate", "researcher"];
const allowedTools = new Set([
  "list_dir", "find_by_name", "grep_search", "view_file", "write_to_file", "replace_file_content",
  "multi_replace_file_content", "run_command", "search_web", "read_url_content",
]);
for (const role of requiredRoles) {
  const path = join(root, "agy-plugin", "agents", `${role}.md`);
  const text = await readFile(path, "utf8");
  assert.match(text, new RegExp(`^name: ${role}$`, "m"));
  assert.match(text, /^description: .+$/m);
  assert.match(text, /^inheritCustomizations: false$/m);
  assert.doesNotMatch(text, /(?:ask_question|start_subagent|invoke_subagent|define_subagent|send_message|manage_subagents)/);
  for (const [, tool] of text.matchAll(/^  - ([a-z_]+)$/gm)) assert.ok(allowedTools.has(tool), `${role}: ${tool}`);
}

const files = ["index.ts", "src/commands.ts", "src/runner.ts", "src/policy.ts", "src/roles.ts", "src/schemas.ts", "src/render.ts"];
for (const file of files) {
  const text = await readFile(join(root, file), "utf8");
  assert.doesNotMatch(text, /dangerously-skip-permissions/);
}
const runnerSource = await readFile(join(root, "src/runner.ts"), "utf8");
assert.match(runnerSource, /shell:\s*false/);
assert.doesNotMatch(runnerSource, /push\("--sandbox"\)/);

// A-04 defense-in-depth environment checks (spec section 9.5.3). Regex checks
// are secondary: the fake-spawn and helper tests remain the authoritative
// immediate-boundary proof.
const envModuleSource = await readFile(join(root, "src/env.ts"), "utf8");
for (const [name, text] of [["src/runner.ts", runnerSource], ["src/env.ts", envModuleSource]]) {
  assert.doesNotMatch(text, /env:\s*process\.env/, `${name}: direct env: process.env pass-through`);
  assert.doesNotMatch(text, /env:\s*parentEnv\b/, `${name}: direct env: parentEnv pass-through`);
  assert.doesNotMatch(text, /\.\.\.\s*\w*[Ee]nv/, `${name}: object-spread environment construction`);
  assert.doesNotMatch(text, /Object\.assign\s*\(\s*\w*[Ee]nv/, `${name}: Object.assign environment construction`);
  assert.doesNotMatch(text, /\bdelete\s+\w+\[?/, `${name}: delete-based environment mutation`);
}
assert.match(runnerSource, /env:\s*childEnv/, "runner must pass a constructed child environment to spawn");
assert.match(envModuleSource, /Object\.create\(null\)/, "child environment must use a null-prototype object");

// Slash commands: wired in index.ts, one per role, with usage + busy guards.
const indexSource = await readFile(join(root, "index.ts"), "utf8");
assert.match(indexSource, /registerAgyCommands\(pi\)/);
const commandsSource = await readFile(join(root, "src/commands.ts"), "utf8");
for (const role of requiredRoles) {
  assert.match(commandsSource, new RegExp(`agy_${role}`));
}
assert.match(commandsSource, /Usage: \/agy_/);
assert.match(commandsSource, /isIdle/);

// Skills: valid names/descriptions, trigger phrases, no allowed-tools.
const skillsDir = join(root, "skills");
const skillNames = await readdir(skillsDir);
assert.deepEqual(skillNames.sort(), ["agy-delegate", "agy-researcher", "agy-scout", "agy-worker"].sort());
for (const dir of skillNames) {
  const skill = await readFile(join(skillsDir, dir, "SKILL.md"), "utf8");
  const nameMatch = skill.match(/^name: ([a-z0-9-]+)$/m);
  assert.ok(nameMatch, `${dir}: missing name`);
  assert.equal(nameMatch[1], dir);
  assert.ok(skill.length < 40 * 80, `${dir}: SKILL.md too long`);
  assert.match(skill, /^description: .{20,}$/m);
  assert.match(skill, /Use when /);
  assert.doesNotMatch(skill, /^allowed-tools:/m);
}

const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.deepEqual(packageJson.pi.extensions, ["./index.ts"]);
console.log(`Static checks passed for ${files.length + 1} source files, ${requiredRoles.length} role definitions, and ${skillNames.length} skills.`);
