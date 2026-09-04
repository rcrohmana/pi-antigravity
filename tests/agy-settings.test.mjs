import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAllowedCommands,
  parseCommandAllowRules,
  resolveAgySettingsPath,
} from "../src/agy-settings.ts";
import { buildAgyPrompt } from "../src/runner.ts";

test("resolveAgySettingsPath: win32 uses USERPROFILE case-insensitively", () => {
  const path = resolveAgySettingsPath({ UserProfile: "C:\\Users\\Rian" }, "win32");
  assert.equal(path, "C:\\Users\\Rian\\.gemini\\antigravity-cli\\settings.json");
});

test("resolveAgySettingsPath: win32 returns undefined when USERPROFILE is missing", () => {
  assert.equal(resolveAgySettingsPath({}, "win32"), undefined);
});

test("resolveAgySettingsPath: posix uses HOME", () => {
  const path = resolveAgySettingsPath({ HOME: "/home/rian" }, "linux");
  assert.equal(path, "/home/rian/.gemini/antigravity-cli/settings.json");
});

test("resolveAgySettingsPath: posix returns undefined when HOME is missing", () => {
  assert.equal(resolveAgySettingsPath({}, "darwin"), undefined);
});

test("parseCommandAllowRules: keeps command() rules, ignores other rule kinds", () => {
  const rules = parseCommandAllowRules({
    permissions: {
      allow: [
        "command(git status)",
        "command(npm test)",
        "read_file(C:/Users/rian)",
        "write_file(C:/Users/rian)",
        "read_url(*)",
      ],
    },
  });
  assert.deepEqual(rules, ["git status", "npm test"]);
});

test("parseCommandAllowRules: trims targets and de-duplicates while preserving order", () => {
  const rules = parseCommandAllowRules({
    permissions: { allow: ["command( git status )", "command(npm test)", "command(git status)"] },
  });
  assert.deepEqual(rules, ["git status", "npm test"]);
});

test("parseCommandAllowRules: drops (does not truncate) targets longer than 200 chars", () => {
  const longTarget = "x".repeat(201);
  const shortTarget = "y".repeat(200);
  const rules = parseCommandAllowRules({
    permissions: { allow: [`command(${longTarget})`, `command(${shortTarget})`] },
  });
  assert.deepEqual(rules, [shortTarget]);
});

test("parseCommandAllowRules: caps at 50 entries", () => {
  const allow = Array.from({ length: 60 }, (_, i) => `command(cmd-${i})`);
  const rules = parseCommandAllowRules({ permissions: { allow } });
  assert.equal(rules.length, 50);
  assert.deepEqual(rules, allow.slice(0, 50).map((entry) => entry.slice("command(".length, -1)));
});

for (const [label, json] of [
  ["null", null],
  ["array", ["command(git status)"]],
  ["missing permissions", {}],
  ["permissions not object", { permissions: "nope" }],
  ["allow not array", { permissions: { allow: "command(git status)" } }],
  ["non-string entries", { permissions: { allow: [42, null, { command: "git status" }] } }],
  ["undefined", undefined],
  ["string", "command(git status)"],
]) {
  test(`parseCommandAllowRules: tolerates malformed shape (${label})`, () => {
    assert.deepEqual(parseCommandAllowRules(json), []);
  });
}

test("loadAllowedCommands: success reads permissions.allow via injected readFile", async () => {
  const result = await loadAllowedCommands({
    env: { USERPROFILE: "C:\\Users\\Rian" },
    platform: "win32",
    readFile: async (path) => {
      assert.equal(path, "C:\\Users\\Rian\\.gemini\\antigravity-cli\\settings.json");
      return JSON.stringify({ permissions: { allow: ["command(git status)", "command(npm test)"] } });
    },
  });
  assert.deepEqual(result, {
    commands: ["git status", "npm test"],
    source: "settings",
    path: "C:\\Users\\Rian\\.gemini\\antigravity-cli\\settings.json",
  });
});

test("loadAllowedCommands: missing base env variable is unavailable without a path", async () => {
  const result = await loadAllowedCommands({ env: {}, platform: "win32" });
  assert.equal(result.source, "unavailable");
  assert.equal(result.path, undefined);
  assert.deepEqual(result.commands, []);
  assert.equal(typeof result.reason, "string");
});

test("loadAllowedCommands: ENOENT (missing file) is unavailable with a names-only reason", async () => {
  const error = new Error("no such file");
  error.code = "ENOENT";
  const result = await loadAllowedCommands({
    env: { HOME: "/home/rian" },
    platform: "linux",
    readFile: async () => {
      throw error;
    },
  });
  assert.deepEqual(result.commands, []);
  assert.equal(result.source, "unavailable");
  assert.equal(result.reason, "ENOENT");
  assert.equal(result.path, "/home/rian/.gemini/antigravity-cli/settings.json");
});

test("loadAllowedCommands: invalid JSON is unavailable and never leaks file content in reason", async () => {
  const result = await loadAllowedCommands({
    env: { HOME: "/home/rian" },
    platform: "linux",
    readFile: async () => "{ not json, super secret token abc123",
  });
  assert.deepEqual(result.commands, []);
  assert.equal(result.source, "unavailable");
  assert.equal(result.reason, "invalid JSON");
  assert.doesNotMatch(result.reason, /secret|token|abc123/);
});

test("loadAllowedCommands: too large is unavailable", async () => {
  const result = await loadAllowedCommands({
    env: { HOME: "/home/rian" },
    platform: "linux",
    maxBytes: 10,
    readFile: async () => JSON.stringify({ permissions: { allow: ["command(git status)"] } }),
  });
  assert.deepEqual(result.commands, []);
  assert.equal(result.source, "unavailable");
  assert.equal(result.reason, "too large");
});

test("buildAgyPrompt: with allowedCommands lists each rule and warns off probe commands", () => {
  const prompt = buildAgyPrompt("do the thing", "C:\\ws", undefined, undefined, {
    allowedCommands: ["git status", "npm test"],
  });
  assert.match(prompt, /Command policy/);
  assert.match(prompt, /^- git status$/m);
  assert.match(prompt, /^- npm test$/m);
  assert.match(prompt, /python --version/);
});

test("buildAgyPrompt: with empty allowedCommands tells the model to run nothing", () => {
  const prompt = buildAgyPrompt("do the thing", "C:\\ws", undefined, undefined, { allowedCommands: [] });
  assert.match(prompt, /Command policy/);
  assert.match(prompt, /Do not call run_command at all\./);
});

test("buildAgyPrompt: without a policy has no Command policy section", () => {
  const prompt = buildAgyPrompt("do the thing", "C:\\ws");
  assert.doesNotMatch(prompt, /Command policy/);
});
