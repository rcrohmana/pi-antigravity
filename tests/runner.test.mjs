import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { win32 as win32Path } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AgyRunnerError } from "../src/schemas.ts";
import { buildAgyChildEnv } from "../src/env.ts";
import {
  NdjsonParser,
  buildAgyArgs,
  classifyDiagnostics,
  describeDeniedTool,
  formatModelVisibleResponse,
  describeToolTarget,
  formatPermissionDenialNotice,
  killProcessTree,
  parseNdjsonLine,
  runAgy,
  resolveAgyExecutable,
} from "../src/runner.ts";

const fixture = async (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

class FakeChild extends EventEmitter {
  constructor({ output = "", error = "", close = true, code = 0, delay = 0 } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdinPayload = undefined;
    this.stdinEnded = false;
    this.stdin = new EventEmitter();
    this.stdin.end = (payload) => { this.stdinPayload = payload; this.stdinEnded = true; };
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
    this.pid = undefined;
    this.killed = false;
    if (output || error) {
      setTimeout(() => {
        if (output) this.stdout.emit("data", output);
        if (error) this.stderr.emit("data", error);
        if (close) this.emit("close", code, null);
      }, delay);
    }
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

function spawnFixture(text, options = {}) {
  let child;
  const spawn = (command, args, spawnOptions) => {
    child = new FakeChild({ output: text, ...options });
    spawn.last = { command, args, spawnOptions };
    return child;
  };
  spawn.child = () => child;
  return spawn;
}

// ---- A-04 child-environment isolation test corpus (synthetic values only) ----

const CANARY_NAME = "A04_TEST_CANARY";

// Host-appropriate absolute sentinel for injected fake spawn implementations; a
// bare executable name is rejected for every spawn path, fake or real. runAgy()
// integration always runs natively on the host platform, so one host-appropriate
// constant suffices; pure helper/resolver tests simulate other platforms
// directly with their own platform parameters.
const FAKE_EXECUTABLE = process.platform === "win32" ? "C:\\SyntheticAgy\\agy-test.exe" : "/synthetic/agy-test";

const WIN32_CHILD_ENV_ALLOWLIST = [
  "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "ProgramData",
  "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME",
];

const UNIX_CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "USER", "LOGNAME",
];

const SECRET_NAMES = [
  "BAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET", "GITHUB_TOKEN", "CI", "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_REGISTRY", "PI_SESSION_ID", "HTTP_PROXY", "HTTPS_PROXY",
  "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "A04_TOTALLY_UNKNOWN_SECRET",
];

function syntheticSourceEnv(overrides = {}) {
  const env = {
    PATH: "C:\\SyntheticPath",
    SystemRoot: "C:\\SyntheticWindows",
    WINDIR: "C:\\SyntheticWindows",
    ComSpec: "C:\\SyntheticWindows\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT",
    TEMP: "C:\\SyntheticTemp",
    TMP: "C:\\SyntheticTemp",
    USERPROFILE: "C:\\SyntheticUsers\\synthetic",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\SyntheticUsers\\synthetic",
    LOCALAPPDATA: "C:\\SyntheticUsers\\synthetic\\AppData\\Local",
    APPDATA: "C:\\SyntheticUsers\\synthetic\\AppData\\Roaming",
    ProgramData: "C:\\SyntheticProgramData",
    LOGONSERVER: "\\\\SyntheticServer",
    SYSTEMDRIVE: "C:",
    USERDOMAIN: "SYNTHETIC-DOMAIN",
    USERNAME: "synthetic",
    HOME: "/home/synthetic",
    TMPDIR: "/tmp/synthetic",
    XDG_CONFIG_HOME: "/home/synthetic/.config",
    XDG_DATA_HOME: "/home/synthetic/.local/share",
    XDG_CACHE_HOME: "/home/synthetic/.cache",
    USER: "synthetic",
    LOGNAME: "synthetic",
    AGY_CLI_PATH: "C:\\SyntheticCustom\\agy.exe",
    [CANARY_NAME]: "synthetic-canary-value",
    ...overrides,
  };
  for (const name of SECRET_NAMES) env[name] = `synthetic-${name.toLowerCase()}-value`;
  return env;
}

function assertChildEnvIsAllowListed(childEnv, platform, context) {
  const allowlist = platform === "win32" ? WIN32_CHILD_ENV_ALLOWLIST : UNIX_CHILD_ENV_ALLOWLIST;
  const unexpected = Object.keys(childEnv).filter((key) =>
    !allowlist.some((name) => (platform === "win32" ? name.toLowerCase() === key.toLowerCase() : name === key)),
  );
  assert.deepEqual(unexpected, [], `${context}: non-allow-listed names (names only): ${unexpected.join(", ")}`);
  for (const name of [...SECRET_NAMES, "AGY_CLI_PATH", CANARY_NAME]) {
    assert.equal(
      Object.hasOwn(childEnv, name),
      false,
      `${context}: non-allow-listed name reached the child environment: ${name}`,
    );
  }
}

test("parses chunked NDJSON and preserves event order", () => {
  const parser = new NdjsonParser();
  const events = [
    ...parser.push('{"event":"init","init":{"conversation_id":"c"}}\n{"event":"step_'),
    ...parser.push('update","step_update":{"step_type":"tool"}}\n'),
    ...parser.finish(),
  ];
  assert.deepEqual(events.map((event) => event.event), ["init", "step_update"]);
});

test("rejects malformed NDJSON loudly", () => {
  assert.throws(() => parseNdjsonLine("not-json"), (error) => error instanceof AgyRunnerError && error.code === "protocol_error");
});

test("maps successful stream result and forwards progress", async () => {
  const text = await fixture("success.ndjson");
  const progress = [];
  const spawn = spawnFixture(text);
  const result = await runAgy({
    role: "scout",
    task: "inspect",
    cwd: process.cwd(),
    executable: FAKE_EXECUTABLE,
    spawnImpl: spawn,
    onProgress: (item) => progress.push(item),
  });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.response, "hello world\n");
  assert.equal(result.conversationId, "conv-123");
  assert.equal(result.usage.total_tokens, 14);
  assert.equal(progress.length, 3);
  assert.equal(spawn.last.spawnOptions.shell, false);
  assert.equal(spawn.last.spawnOptions.cwd, process.cwd());
  assert.ok(spawn.last.args.includes("--output-format"));
  assert.equal(spawn.last.args.includes("--print"), false);
  assert.equal(spawn.child().stdinEnded, true);
  assert.deepEqual(JSON.parse(spawn.child().stdinPayload), {
    event: "user",
    message: {
      content: `Selected workspace (canonical): ${JSON.stringify(process.cwd())}\n\nUse this workspace for all local file operations. Do not search outside it.\n\nTask:\ninspect`,
    },
  });
});

test("fails on Agy error status with permission-flavored stderr as an actionable permission_denied", async () => {
  const spawn = spawnFixture(await fixture("error.ndjson"), { error: "permission denied: run_command requires approval\n" });
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn }),
    (error) => error instanceof AgyRunnerError && error.code === "permission_denied" && error.status === "ERROR" && error.message.includes("permission denied"),
  );
});

test("fails on Agy error status with non-permission stderr as plain agy_status", async () => {
  const spawn = spawnFixture(await fixture("error.ndjson"), { error: "network unreachable\n" });
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn }),
    (error) => error instanceof AgyRunnerError && error.code === "agy_status" && error.status === "ERROR" && error.message.includes("network unreachable"),
  );
});

test("fails when terminal result is missing", async () => {
  const spawn = spawnFixture(await fixture("missing-result.ndjson"));
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn }),
    (error) => error instanceof AgyRunnerError && error.code === "missing_result",
  );
});

test("surfaces successful-run permission diagnostics as escalation", async () => {
  const spawn = spawnFixture(await fixture("success.ndjson"), { error: "permission denied: run_command requires approval\n" });
  const result = await runAgy({ role: "worker", task: "inspect", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn });
  assert.equal(result.escalationRequired, true);
  assert.match(formatModelVisibleResponse(result), /ESCALATION REQUIRED/);
  assert.match(formatModelVisibleResponse(result), /permission denied/);
});

test("fails on malformed stream and attempts cleanup", async () => {
  const spawn = spawnFixture(await fixture("malformed.ndjson"));
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn }),
    (error) => error instanceof AgyRunnerError && error.code === "protocol_error",
  );
  assert.equal(spawn.child().killed, true);
});

test("failed first termination still reaches forced cleanup", async () => {
  class ResistantChild extends FakeChild {
    kills = 0;
    kill() {
      this.kills += 1;
      if (this.kills > 1) queueMicrotask(() => this.emit("close", null, "SIGKILL"));
      return true;
    }
  }
  const child = new ResistantChild({ output: await fixture("malformed.ndjson"), close: false });
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: () => child }),
    (error) => error instanceof AgyRunnerError && error.code === "protocol_error",
  );
  assert.ok(child.kills >= 2);
});

test("already-aborted signal prevents spawn and stdin", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(
    runAgy({ role: "scout", task: "must not run", cwd: process.cwd(), executable: FAKE_EXECUTABLE, signal: controller.signal, spawnImpl: () => { spawned = true; throw new Error("spawned"); } }),
    (error) => error instanceof AgyRunnerError && error.code === "aborted",
  );
  assert.equal(spawned, false);
});

test("stdin errors become bounded runner failures", async () => {
  const spawn = () => {
    const child = new FakeChild({ close: false });
    queueMicrotask(() => child.stdin.emit("error", new Error("EPIPE")));
    return child;
  };
  await assert.rejects(
    runAgy({ role: "scout", task: "send", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn }),
    (error) => error instanceof AgyRunnerError && error.code === "spawn_error" && error.message.includes("EPIPE"),
  );
});

test("timeout and AbortSignal cancel the child", async () => {
  let timeoutChild;
  const neverSpawn = () => {
    timeoutChild = new FakeChild({ close: false });
    return timeoutChild;
  };
  await assert.rejects(
    runAgy({ role: "scout", task: "wait", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: neverSpawn, timeoutMs: 15 }),
    (error) => error instanceof AgyRunnerError && error.code === "timeout",
  );
  assert.equal(timeoutChild.killed, true);

  const controller = new AbortController();
  let abortChild;
  const abortSpawn = () => {
    abortChild = new FakeChild({ close: false });
    return abortChild;
  };
  const pending = runAgy({ role: "scout", task: "wait", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: abortSpawn, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof AgyRunnerError && error.code === "aborted");
  assert.equal(abortChild.killed, true);
});

test("resolves AGY_CLI_PATH before PATH and the Windows local fallback", () => {
  const files = new Set(["C:\\custom\\agy.exe", "C:\\path\\agy.exe", "C:\\local\\agy\\bin\\agy.exe"]);
  const exists = (path) => files.has(path);
  assert.equal(resolveAgyExecutable({ AGY_CLI_PATH: "C:\\custom\\agy.exe", PATH: "C:\\path", LOCALAPPDATA: "C:\\local" }, "win32", exists), "C:\\custom\\agy.exe");
  assert.equal(resolveAgyExecutable({ PATH: "C:\\path", LOCALAPPDATA: "C:\\local" }, "win32", exists), "C:\\path\\agy.exe");
  assert.equal(resolveAgyExecutable({ PATH: "", LOCALAPPDATA: "C:\\local" }, "win32", exists), "C:\\local\\agy\\bin\\agy.exe");
});

test("classifies and retains headless auto-denial escalation", () => {
  const diagnostic = 'a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied';
  assert.equal(classifyDiagnostics(diagnostic), true);
  const output = formatModelVisibleResponse({
    response: "x".repeat(50_000),
    diagnostics: diagnostic,
    escalationRequired: true,
  });
  assert.match(output, /ESCALATION REQUIRED/);
  assert.match(output, /auto-denied/);
  assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
  assert.ok(output.split("\n").length <= 2_000);
});

test("bounds combined multibyte and line-heavy model output", () => {
  const response = `${"🙂".repeat(30_000)}\n${Array.from({ length: 2_100 }, (_, index) => `line-${index}`).join("\n")}`;
  const output = formatModelVisibleResponse({
    response,
    diagnostics: "permission denied: run_command requires approval",
    escalationRequired: true,
  });
  assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
  assert.ok(output.split("\n").length <= 2_000);
  assert.match(output, /output truncated/);
  assert.match(output, /ESCALATION REQUIRED/);
  assert.match(output, /permission denied/);
});

test("bounds line-heavy output below the byte cap", () => {
  const output = formatModelVisibleResponse({ response: `${"x\n".repeat(2_100)}`, diagnostics: undefined, escalationRequired: false });
  assert.ok(Buffer.byteLength(output, "utf8") < 50 * 1024);
  assert.ok(output.split("\n").length <= 2_000);
  assert.match(output, /output truncated/);
});

test("bounds oversized Agy result errors", async () => {
  const output = `${JSON.stringify({ event: "result", result: { status: "ERROR", error: "🙂".repeat(20_000) } })}\n`;
  await assert.rejects(
    runAgy({ role: "scout", task: "error", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawnFixture(output) }),
    (error) => {
      assert.ok(error instanceof AgyRunnerError);
      assert.ok(Buffer.byteLength(error.message, "utf8") <= 50 * 1024);
      assert.ok(error.message.split("\n").length <= 2_000);
      assert.match(error.message, /output truncated/);
      return error.code === "agy_status";
    },
  );
});

test("does not turn task text into policy or cwd flags", () => {
  const args = buildAgyArgs({ role: "worker", task: "--cwd evil --dangerously-skip-permissions", cwd: "C:\\workspace", mode: "accept-edits" }, 1000);
  assert.equal(args.filter((arg) => arg === "--dangerously-skip-permissions").length, 0);
  assert.equal(args.includes("Task:\n--cwd evil --dangerously-skip-permissions"), false);
  assert.equal(args.includes("--cwd"), false);
  assert.equal(args[0], "--input-format");
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "accept-edits"]);
});

test("never emits --sandbox", async () => {
  for (const mode of ["default", "accept-edits"]) {
    const args = buildAgyArgs({ role: "worker", task: "work", cwd: "C:\\workspace", mode }, 1000);
    assert.equal(args.includes("--sandbox"), false);
  }
  const source = await readFile(new URL("../src/runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /push\("--sandbox"\)/);
});

test("omits --mode for the flagless default mode", () => {
  const scoutArgs = buildAgyArgs({ role: "scout", task: "inspect", cwd: "C:\\workspace", mode: "default" }, 1000);
  assert.equal(scoutArgs.includes("--mode"), false);
  const researcherArgs = buildAgyArgs({ role: "researcher", task: "research", cwd: "C:\\workspace", mode: "default" }, 1000);
  assert.equal(researcherArgs.includes("--mode"), false);
});


// ---- Actionable headless permission-denial diagnostics ----

test("headless permission denial on a SUCCESS run surfaces an actionable deniedTools entry", async () => {
  const stderrText = await fixture("denied-command.stderr.txt");
  const spawn = spawnFixture(await fixture("denied-command.ndjson"), { error: stderrText });
  const result = await runAgy({ role: "worker", task: "probe", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.escalationRequired, true);
  assert.equal(result.deniedTools?.length, 1);
  assert.deepEqual(result.deniedTools[0], {
    toolName: "run_command",
    summary: "echo probe",
    message: 'permission check failed for command "echo probe": user denied permission to run command:\necho probe',
    suggestedRule: "command(echo probe)",
  });
  const modelVisible = formatModelVisibleResponse(result);
  assert.match(modelVisible, /ESCALATION REQUIRED/);
  assert.match(modelVisible, /command\(echo probe\)/);
  assert.match(modelVisible, /auto-denied/);
});

test("headless permission denial on a CANCELED run rejects as permission_denied, not a plain status failure", async () => {
  const spawn = spawnFixture(await fixture("denied-canceled.ndjson"));
  await assert.rejects(
    runAgy({ role: "worker", task: "probe", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn }),
    (error) => {
      assert.ok(error instanceof AgyRunnerError);
      assert.equal(error.code, "permission_denied");
      assert.equal(error.status, "CANCELED");
      assert.match(error.message, /not a user cancel/);
      assert.match(error.message, /command\(python --version; node --version\)/);
      return true;
    },
  );
});

test("describeDeniedTool extracts actionable summaries and suggested allow rules per tool family", () => {
  const viewFileResult = describeDeniedTool({
    step_type: "tool",
    state: "ERROR",
    tool_name: "view_file",
    tool_info: {
      name: "view_file",
      parameters: { AbsolutePath: "C:\\Users\\rcroh\\project\\file.txt" },
      error: { type: "TOOL_ERROR", message: "user denied permission for read_file(C:\\Users\\rcroh\\project\\file.txt)" },
    },
  });
  assert.equal(viewFileResult.toolName, "view_file");
  assert.equal(viewFileResult.summary, "C:\\Users\\rcroh\\project\\file.txt");
  assert.equal(viewFileResult.suggestedRule, "read_file(C:/Users/rcroh/project/file.txt)");

  const writeResult = describeDeniedTool({
    step_type: "tool",
    state: "ERROR",
    tool_name: "write_to_file",
    tool_info: {
      name: "write_to_file",
      parameters: { TargetFile: "C:\\Users\\rcroh\\project\\out.txt" },
      error: { type: "TOOL_ERROR", message: "user denied permission for write_file(C:\\Users\\rcroh\\project\\out.txt)" },
    },
  });
  assert.equal(writeResult.suggestedRule, "write_file(C:/Users/rcroh/project/out.txt)");

  const urlResult = describeDeniedTool({
    step_type: "tool",
    state: "ERROR",
    tool_name: "read_url_content",
    tool_info: {
      name: "read_url_content",
      parameters: { Url: "https://localhost/x" },
      error: {
        type: "TOOL_ERROR",
        message: 'permission check failed for read_url "localhost": Permission denied for read_url(localhost). Matches user-configured deny rule.',
      },
    },
  });
  assert.equal(urlResult.suggestedRule, "read_url(localhost)");

  const unknownToolResult = describeDeniedTool({
    step_type: "tool",
    state: "ERROR",
    tool_name: "some_future_tool",
    tool_info: {
      name: "some_future_tool",
      parameters: { Foo: "bar" },
      error: { type: "TOOL_ERROR", message: "user denied permission for some_future_tool" },
    },
  });
  assert.equal(unknownToolResult.toolName, "some_future_tool");
  assert.equal(unknownToolResult.suggestedRule, undefined);

  const nonErrorStep = describeDeniedTool({
    step_type: "tool",
    state: "DONE",
    tool_name: "view_file",
    tool_info: { name: "view_file", parameters: {} },
  });
  assert.equal(nonErrorStep, undefined);

  const nonPermissionError = describeDeniedTool({
    step_type: "tool",
    state: "ERROR",
    tool_name: "run_command",
    tool_info: {
      name: "run_command",
      parameters: { CommandLine: "echo hi" },
      error: { type: "TOOL_ERROR", message: "command exited with code 1" },
    },
  });
  assert.equal(nonPermissionError, undefined);
});

test("formatPermissionDenialNotice falls back to denied_actions when no per-tool detail is available", () => {
  const notice = formatPermissionDenialNotice({
    deniedTools: [],
    deniedActions: [{ action: "command", displayName: "RunCommand" }],
  });
  assert.match(notice, /auto-denied/);
  assert.match(notice, /RunCommand/);
  assert.match(notice, /command\(<target>\)/);
});

// ---- A-04 section 9.1: pure helper tests (buildAgyChildEnv) ----

test("buildAgyChildEnv copies only the allow-list and never synthetic secrets", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const source = syntheticSourceEnv();
    const childEnv = buildAgyChildEnv(source, platform);
    const allowlist = platform === "win32" ? WIN32_CHILD_ENV_ALLOWLIST : UNIX_CHILD_ENV_ALLOWLIST;
    assert.deepEqual(
      Object.keys(childEnv).sort(),
      [...allowlist].sort(),
      `${platform}: emitted key names (names only)`,
    );
    assertChildEnvIsAllowListed(childEnv, platform, platform);
  }
});

test("buildAgyChildEnv leaves the source object, keys, descriptors, and values unchanged", () => {
  const source = syntheticSourceEnv();
  const beforeKeys = Object.keys(source);
  const beforeDescriptors = Object.getOwnPropertyDescriptors(source);
  buildAgyChildEnv(source, "win32");
  assert.deepEqual(Object.keys(source), beforeKeys);
  assert.deepEqual(Object.getOwnPropertyDescriptors(source), beforeDescriptors);
});

test("empty and missing allow-listed variables are omitted, never synthesized", () => {
  const childEnv = buildAgyChildEnv({ PATH: "", HOME: "/home/synthetic", TMPDIR: "" }, "linux");
  assert.deepEqual(Object.keys(childEnv), ["HOME"]);
  const partial = buildAgyChildEnv({ PATH: undefined, HOME: "/home/synthetic" }, "linux");
  assert.deepEqual(Object.keys(partial), ["HOME"]);
  const none = buildAgyChildEnv({}, "win32");
  assert.deepEqual(Object.keys(none), []);
});

test("each call returns a fresh object with a null prototype", () => {
  const source = syntheticSourceEnv();
  const first = buildAgyChildEnv(source, "win32");
  const second = buildAgyChildEnv(source, "win32");
  assert.notEqual(first, second);
  assert.notEqual(first, source);
  assert.equal(Object.getPrototypeOf(first), null);
  assert.equal(Object.getPrototypeOf(second), null);
});

test("inherited properties, allowed and secret, are not copied", () => {
  const base = { PATH: "/inherited/synthetic", BAI_API_KEY: "synthetic-secret-value" };
  const source = Object.create(base);
  source.HOME = "/home/synthetic";
  const childEnv = buildAgyChildEnv(source, "linux");
  assert.deepEqual(Object.keys(childEnv), ["HOME"]);
});

test("accessor properties are ignored without invoking the getter", () => {
  let getterCalls = 0;
  const source = {};
  Object.defineProperty(source, "PATH", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "/synthetic/from-getter";
    },
  });
  source.HOME = "/home/synthetic";
  const childEnv = buildAgyChildEnv(source, "linux");
  assert.equal(Object.hasOwn(childEnv, "PATH"), false, "accessor PATH reached the child environment");
  assert.equal(childEnv.HOME, "/home/synthetic");
  assert.equal(getterCalls, 0);

  // Windows variant: an accessor under a non-canonical casing is also skipped.
  let winGetterCalls = 0;
  const winSource = {};
  Object.defineProperty(winSource, "Path", {
    enumerable: true,
    get() {
      winGetterCalls += 1;
      return "/synthetic/from-getter";
    },
  });
  winSource.PATH = "/synthetic/data-value";
  const winChildEnv = buildAgyChildEnv(winSource, "win32");
  assert.deepEqual(Object.keys(winChildEnv), ["PATH"]);
  assert.equal(winChildEnv.PATH, "/synthetic/data-value");
  assert.equal(winGetterCalls, 0);
});

test("Windows casing: exactly one canonical PATH is emitted from mixed-casing inputs", () => {
  const childEnv = buildAgyChildEnv({ path: "/synthetic/lower", Path: "/synthetic/mixed", PATH: "/synthetic/upper" }, "win32");
  assert.deepEqual(Object.keys(childEnv), ["PATH"]);
  assert.equal(childEnv.PATH, "/synthetic/upper");
  const skippedEmpty = buildAgyChildEnv({ PATH: "", Path: "/synthetic/mixed" }, "win32");
  assert.deepEqual(Object.keys(skippedEmpty), ["PATH"]);
  assert.equal(skippedEmpty.PATH, "/synthetic/mixed");
});

test("Windows duplicate casings with different values select deterministically", () => {
  const childEnv = buildAgyChildEnv(
    { systemroot: "/synthetic/lower", SystemRoot: "/synthetic/mixed", SYSTEMROOT: "/synthetic/upper" },
    "win32",
  );
  assert.deepEqual(Object.keys(childEnv), ["SystemRoot"]);
  assert.equal(childEnv.SystemRoot, "/synthetic/upper");
});

test("every Windows allow-listed name is emitted once with canonical spelling from non-canonical casings", () => {
  const source = {};
  for (const name of WIN32_CHILD_ENV_ALLOWLIST) source[name.toLowerCase()] = `/synthetic/${name.toLowerCase()}`;
  const childEnv = buildAgyChildEnv(source, "win32");
  assert.deepEqual(Object.keys(childEnv).sort(), [...WIN32_CHILD_ENV_ALLOWLIST].sort());
  for (const name of WIN32_CHILD_ENV_ALLOWLIST) {
    assert.equal(Object.hasOwn(childEnv, name), true, `canonical ${name} missing from child env`);
    assert.equal(childEnv[name], `/synthetic/${name.toLowerCase()}`);
    assert.equal(Object.hasOwn(childEnv, name.toLowerCase()), false, `non-canonical ${name.toLowerCase()} leaked into child env`);
  }
});

test("Windows does not copy Unix-only variables", () => {
  const childEnv = buildAgyChildEnv(
    { HOME: "/home/synthetic", TMPDIR: "/tmp/synthetic", XDG_CONFIG_HOME: "/synthetic/.config", USER: "synthetic", LOGNAME: "synthetic" },
    "win32",
  );
  assert.deepEqual(Object.keys(childEnv), []);
});

test("Linux and macOS copy only their exact-case allow-lists and exclude Windows-only values", () => {
  for (const platform of ["linux", "darwin"]) {
    const childEnv = buildAgyChildEnv(syntheticSourceEnv(), platform);
    assert.deepEqual(Object.keys(childEnv).sort(), [...UNIX_CHILD_ENV_ALLOWLIST].sort());
    for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "ProgramData"]) {
      assert.equal(Object.hasOwn(childEnv, name), false, `Windows-only name reached the ${platform} child env: ${name}`);
    }
    const wrongCase = buildAgyChildEnv({ path: "/synthetic/lower", HOME: "/home/synthetic" }, platform);
    assert.deepEqual(Object.keys(wrongCase), ["HOME"]);
  }
});

test("unsupported platforms throw before returning an environment", () => {
  for (const platform of ["freebsd", "aix", "sunos"]) {
    assert.throws(
      () => buildAgyChildEnv(syntheticSourceEnv(), platform),
      (error) => error instanceof Error && error.message.includes(`Unsupported Agy platform "${platform}"`),
    );
  }
});

// ---- A-04 section 9.2: executable-resolution tests ----

test("Windows resolution observes mixed-case AGY_CLI_PATH, PATH, LOCALAPPDATA, and USERPROFILE via the shared lookup", () => {
  const files = new Set([
    "C:\\SyntheticCustom\\agy.exe",
    "C:\\SyntheticPath\\agy.exe",
    "C:\\SyntheticLocal\\agy\\bin\\agy.exe",
    "C:\\SyntheticUsers\\synthetic\\AppData\\Local\\agy\\bin\\agy.exe",
  ]);
  const exists = (path) => files.has(path);
  assert.equal(resolveAgyExecutable({ aGy_Cli_PaTh: "C:\\SyntheticCustom\\agy.exe" }, "win32", exists), "C:\\SyntheticCustom\\agy.exe");
  assert.equal(resolveAgyExecutable({ Path: "C:\\SyntheticPath" }, "win32", exists), "C:\\SyntheticPath\\agy.exe");
  assert.equal(resolveAgyExecutable({ LocalAppData: "C:\\SyntheticLocal" }, "win32", exists), "C:\\SyntheticLocal\\agy\\bin\\agy.exe");
  assert.equal(
    resolveAgyExecutable({ userProfile: "C:\\SyntheticUsers\\synthetic" }, "win32", exists),
    "C:\\SyntheticUsers\\synthetic\\AppData\\Local\\agy\\bin\\agy.exe",
  );
});

test("Linux and macOS resolution remains case-sensitive", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.throws(
      () => resolveAgyExecutable({ agy_cli_path: "/synthetic/custom/agy", path: "/synthetic/bin" }, platform, () => true),
      (error) => error instanceof AgyRunnerError && error.code === "executable_not_found",
    );
    assert.equal(resolveAgyExecutable({ AGY_CLI_PATH: "/synthetic/custom/agy" }, platform, () => true), "/synthetic/custom/agy");
    assert.equal(resolveAgyExecutable({ PATH: "/synthetic/bin" }, platform, (p) => p === "/synthetic/bin/agy"), "/synthetic/bin/agy");
  }
});

test("resolution normalizes candidates to absolute paths before acceptance", () => {
  const seen = [];
  const exists = (path) => {
    seen.push(path);
    return true;
  };
  const fromRelativePathEntry = resolveAgyExecutable({ PATH: "SyntheticRelative\\dir" }, "win32", exists);
  assert.equal(fromRelativePathEntry, seen[0]);
  for (const candidate of seen) {
    assert.equal(win32Path.isAbsolute(candidate), true, `candidate was not absolute (length ${candidate.length})`);
  }
  const seenRelativeCli = [];
  const fromRelativeCli = resolveAgyExecutable(
    { AGY_CLI_PATH: "SyntheticRelative\\agy.exe", PATH: "" },
    "win32",
    (path) => {
      seenRelativeCli.push(path);
      return true;
    },
  );
  assert.equal(fromRelativeCli, seenRelativeCli[0]);
  assert.equal(win32Path.isAbsolute(fromRelativeCli), true);
});

test("AGY_CLI_PATH never appears in the child environment under any casing", () => {
  const childEnv = buildAgyChildEnv(syntheticSourceEnv(), "win32");
  for (const key of Object.keys(childEnv)) {
    assert.notEqual(key.toLowerCase(), "agy_cli_path", "AGY_CLI_PATH reached the child environment");
  }
});

test("a non-absolute options.executable is rejected for real/default spawn before spawn", async () => {
  await assert.rejects(
    runAgy({ role: "scout", task: "synthetic", cwd: process.cwd(), executable: "agy-test", env: syntheticSourceEnv() }),
    (error) =>
      error instanceof AgyRunnerError &&
      error.code === "executable_not_found" &&
      error.message.includes("must be an absolute path"),
  );
});

test("options.executable must be absolute even with an injected fake spawnImpl", async () => {
  // A wrapper around the default spawn could still reach the real process, so
  // the absolute requirement is unconditional.
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      executable: "agy-test",
      env: syntheticSourceEnv(),
      spawnImpl: spawnFixture(await fixture("success.ndjson")),
    }),
    (error) => error instanceof AgyRunnerError && error.code === "executable_not_found" && error.message.includes("must be an absolute path"),
  );
  const spawn = spawnFixture(await fixture("success.ndjson"));
  const result = await runAgy({
    role: "scout",
    task: "synthetic",
    cwd: process.cwd(),
    executable: FAKE_EXECUTABLE,
    env: syntheticSourceEnv(),
    spawnImpl: spawn,
  });
  assert.equal(result.status, "SUCCESS");
  assert.equal(spawn.last.command, FAKE_EXECUTABLE);
});

test("a win32 runAgy call with missing required source variables fails before spawn with names-only diagnostics", { skip: process.platform !== "win32" }, async () => {
  // The requested source environment omits several libuv-required names; the
  // run must fail closed — for every spawn implementation — instead of letting
  // libuv fill them from ambient process.env outside options.env.
  await assert.rejects(
    runAgy({ role: "scout", task: "synthetic", cwd: process.cwd(), platform: "win32", env: { USERPROFILE: "C:\\SyntheticUsers\\synthetic" } }),
    (error) => {
      assert.ok(error instanceof AgyRunnerError);
      assert.equal(error.code, "spawn_error");
      assert.match(error.message, /required environment variables are missing/);
      for (const name of ["HOMEDRIVE", "LOGONSERVER", "SYSTEMDRIVE", "SystemRoot", "USERDOMAIN", "USERNAME", "WINDIR"]) {
        assert.ok(error.message.includes(name), `missing name not reported: ${name}`);
      }
      assert.doesNotMatch(error.message, /synthetic-canary-value|BAI_API_KEY/);
      return true;
    },
  );
});

test("the win32 required-source gate holds even for a wrapper spawnImpl that reaches the real spawn", { skip: process.platform !== "win32" }, async () => {
  // Regression: the gate must not depend on spawnImpl identity. A wrapper can
  // invoke real spawn, so a partial win32 source environment must be blocked
  // before the wrapper is ever called.
  let wrapperCalls = 0;
  const wrapperSpawn = (command, args, spawnOptions) => {
    wrapperCalls += 1;
    return nodeSpawn(command, args, spawnOptions);
  };
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      platform: "win32",
      env: { USERPROFILE: "C:\\SyntheticUsers\\synthetic" },
      spawnImpl: wrapperSpawn,
    }),
    (error) =>
      error instanceof AgyRunnerError &&
      error.code === "spawn_error" &&
      error.message.includes("required environment variables are missing"),
  );
  assert.equal(wrapperCalls, 0, "the spawn wrapper was invoked despite the missing required source environment");
});

test("a host-mismatched supported platform is rejected before any environment, exists, or spawn access", async () => {
  // Select the platform opposite to the host so the suite stays portable.
  const spoofedPlatform = process.platform === "win32" ? "linux" : "win32";
  let existsCalls = 0;
  let wrapperCalls = 0;
  let envTouched = 0;
  const source = new Proxy(
    {},
    {
      ownKeys() {
        envTouched += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        return undefined;
      },
    },
  );
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      platform: spoofedPlatform,
      executable: FAKE_EXECUTABLE,
      env: source,
      exists: () => {
        existsCalls += 1;
        return true;
      },
      spawnImpl: () => {
        wrapperCalls += 1;
        throw new Error("wrapper reached");
      },
    }),
    (error) => error instanceof Error && error.message.includes(`does not match the host platform "${process.platform}"`),
  );
  assert.equal(envTouched, 0, "source environment was inspected before the host check");
  assert.equal(existsCalls, 0, "exists() ran before the host check");
  assert.equal(wrapperCalls, 0, "the spawn wrapper was invoked despite the host mismatch");
});

test("missing PATH cannot trigger an ambient command-search fallback on the real-spawn path", async () => {
  // The complete required source set is present, so the required-source gate
  // passes and resolution itself must fail closed without an ambient fallback.
  await assert.rejects(
    runAgy({ role: "scout", task: "synthetic", cwd: process.cwd(), env: syntheticSourceEnv({ AGY_CLI_PATH: "" }) }),
    (error) => error instanceof AgyRunnerError && error.code === "executable_not_found",
  );
});

// ---- A-04 section 9.3: runner integration tests with fake spawn ----

test("runAgy gives fake spawn a fresh sanitized null-prototype environment, not the source", async () => {
  const hostAllowlist = process.platform === "win32" ? WIN32_CHILD_ENV_ALLOWLIST : UNIX_CHILD_ENV_ALLOWLIST;
  const spawn = spawnFixture(await fixture("success.ndjson"));
  const source = syntheticSourceEnv();
  const cliPath = process.platform === "win32" ? "C:\\SyntheticCustom\\agy.exe" : "/synthetic/custom/agy";
  source.AGY_CLI_PATH = cliPath;
  const exists = (path) => path === cliPath;
  await runAgy({ role: "scout", task: "synthetic", cwd: process.cwd(), env: source, exists, spawnImpl: spawn });
  const childEnv = spawn.last.spawnOptions.env;
  // Resolution observed the source-only AGY_CLI_PATH before sanitization.
  assert.equal(spawn.last.command, cliPath);
  assert.notEqual(childEnv, source);
  assert.equal(Object.getPrototypeOf(childEnv), null);
  assert.deepEqual(Object.keys(childEnv).sort(), [...hostAllowlist].sort());
  assertChildEnvIsAllowListed(childEnv, process.platform, "spawned child env");

  await runAgy({ role: "scout", task: "synthetic", cwd: process.cwd(), env: source, exists, spawnImpl: spawn });
  assert.notEqual(spawn.last.spawnOptions.env, childEnv, "child environment object was reused across invocations");
  assert.equal(Object.getPrototypeOf(spawn.last.spawnOptions.env), null);
});

test("unsupported platform rejection precedes exists(), environment construction, and spawn", async () => {
  let envTouched = 0;
  let existsCalls = 0;
  let spawnCalls = 0;
  const source = new Proxy(
    {},
    {
      ownKeys() {
        envTouched += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        return undefined;
      },
    },
  );
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      env: source,
      platform: "freebsd",
      exists: () => {
        existsCalls += 1;
        return true;
      },
      spawnImpl: () => {
        spawnCalls += 1;
        return new FakeChild({});
      },
    }),
    (error) => error instanceof Error && error.message.includes('Unsupported Agy platform "freebsd"'),
  );
  assert.equal(envTouched, 0, "environment was inspected before the platform check");
  assert.equal(existsCalls, 0, "exists() ran before the platform check");
  assert.equal(spawnCalls, 0, "spawn ran despite the unsupported platform");
});

test("the source environment object survives every runner outcome", async () => {
  const frozenSource = () => Object.freeze(syntheticSourceEnv());
  const descriptors = (source) => JSON.stringify(Object.getOwnPropertyDescriptors(source));
  const assertUnchanged = (source) => {
    assert.ok(Object.isFrozen(source));
    assert.equal(descriptors(source), descriptors(frozenSource()));
  };

  const spawn = spawnFixture(await fixture("success.ndjson"));
  const successSource = frozenSource();
  await runAgy({ role: "scout", task: "synthetic", cwd: process.cwd(), env: successSource, executable: FAKE_EXECUTABLE, spawnImpl: spawn });
  assertUnchanged(successSource);

  const resolutionSource = frozenSource();
  await assert.rejects(
    runAgy({ role: "scout", task: "synthetic", cwd: process.cwd(), env: resolutionSource, exists: () => false, spawnImpl: spawnFixture("") }),
    (error) => error instanceof AgyRunnerError && error.code === "executable_not_found",
  );
  assertUnchanged(resolutionSource);

  const syncThrowSource = frozenSource();
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      env: syncThrowSource,
      executable: FAKE_EXECUTABLE,
      spawnImpl: () => {
        throw new Error("synthetic synchronous spawn failure");
      },
    }),
    (error) => error instanceof AgyRunnerError && error.code === "spawn_error",
  );
  assertUnchanged(syncThrowSource);

  const asyncFailureSource = frozenSource();
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      env: asyncFailureSource,
      executable: FAKE_EXECUTABLE,
      spawnImpl: spawnFixture(await fixture("error.ndjson"), { error: "synthetic denial\n" }),
    }),
    (error) => error instanceof AgyRunnerError && error.code === "agy_status",
  );
  assertUnchanged(asyncFailureSource);

  const timeoutSource = frozenSource();
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      env: timeoutSource,
      executable: FAKE_EXECUTABLE,
      spawnImpl: () => new FakeChild({ close: false }),
      timeoutMs: 15,
    }),
    (error) => error instanceof AgyRunnerError && error.code === "timeout",
  );
  assertUnchanged(timeoutSource);

  const abortSource = frozenSource();
  const controller = new AbortController();
  const pending = runAgy({
    role: "scout",
    task: "synthetic",
    cwd: process.cwd(),
    env: abortSource,
    executable: FAKE_EXECUTABLE,
    spawnImpl: () => new FakeChild({ close: false }),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof AgyRunnerError && error.code === "aborted");
  assertUnchanged(abortSource);

  const malformedSource = frozenSource();
  await assert.rejects(
    runAgy({
      role: "scout",
      task: "synthetic",
      cwd: process.cwd(),
      env: malformedSource,
      executable: FAKE_EXECUTABLE,
      spawnImpl: spawnFixture(await fixture("malformed.ndjson")),
    }),
    (error) => error instanceof AgyRunnerError && error.code === "protocol_error",
  );
  assertUnchanged(malformedSource);
});

// ---- A-04 section 9.4: offline descendant canary (no model, real processes) ----

const canaryProbePath = fileURLToPath(new URL("./fixtures/env-canary-probe.mjs", import.meta.url));

test("offline descendant canary: non-allow-listed canary is absent from child and grandchild", () => {
  const platform = process.platform;
  if (!["win32", "linux", "darwin"].includes(platform)) return;
  const source = { ...process.env, [CANARY_NAME]: "synthetic-canary-value" };
  assert.equal(Object.hasOwn(source, CANARY_NAME), true, "canary was not planted in the source environment");
  const childEnv = buildAgyChildEnv(source, platform);
  assert.equal(
    Object.hasOwn(childEnv, CANARY_NAME),
    false,
    "canary name present in the environment handed to the child",
  );

  const probe = spawnSync(process.execPath, [canaryProbePath, "child"], {
    env: childEnv,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(probe.error, undefined, `probe failed to start: ${probe.error?.message ?? "unknown"}`);
  assert.equal(probe.status, 0, `probe exited ${probe.status}; bounded stderr: ${(probe.stderr ?? "").slice(-2000)}`);
  const report = JSON.parse(probe.stdout);
  assert.notEqual(
    report.grandchild,
    null,
    `grandchild report missing; grandchildExitCode=${report.grandchildExitCode}; stderr bytes=${report.grandchildStderrLength}`,
  );
  assert.equal(report.child.canaryPresent, false, "canary name present in the child environment");
  assert.equal(report.grandchild.canaryPresent, false, "canary name present in the grandchild environment");

  const allowlist = platform === "win32" ? WIN32_CHILD_ENV_ALLOWLIST : UNIX_CHILD_ENV_ALLOWLIST;
  for (const [label, keys] of [["child", report.child.keys], ["grandchild", report.grandchild.keys]]) {
    assert.deepEqual(keys, [...keys].sort(), `${label} key names are not sorted`);
    // Actual process keys must match ONLY the expanded allow-list: with the
    // identity variables explicitly allow-listed and sourced from options.env,
    // the libuv ambient-fill bypass is closed and there is no runtime-injection
    // exception.
    const unexpected = keys.filter((key) => {
      const matches = (name) => (platform === "win32" ? name.toLowerCase() === key.toLowerCase() : name === key);
      return !allowlist.some(matches);
    });
    assert.deepEqual(unexpected, [], `non-allow-listed names in the ${label} environment (names only): ${unexpected.join(", ")}`);
    for (const name of [...SECRET_NAMES, CANARY_NAME]) {
      assert.equal(
        keys.some((key) => (platform === "win32" ? key.toLowerCase() === name.toLowerCase() : key === name)),
        false,
        `${label}: non-allow-listed name reached the environment: ${name}`,
      );
    }
  }
  if (platform === "win32") {
    // The identity variables must come from the explicitly allow-listed source
    // environment, not from libuv's ambient fill.
    for (const name of ["LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME"]) {
      assert.ok(
        report.child.keys.some((key) => key.toLowerCase() === name.toLowerCase()),
        `identity variable ${name} missing from the child environment`,
      );
    }
  }
  assert.ok(
    report.child.keys.includes("PATH") || (platform === "win32" && report.child.keys.some((key) => key.toLowerCase() === "path")),
    "PATH is missing from the child environment",
  );
});

test("deniedActionsFromDiagnostics extracts permission categories from the headless stderr line", async () => {
  const { deniedActionsFromDiagnostics } = await import("../src/runner.ts");
  const stderr = await fixture("denied-command.stderr.txt");
  assert.deepEqual(deniedActionsFromDiagnostics(stderr), [{ action: "command" }]);
  assert.deepEqual(deniedActionsFromDiagnostics('a tool required the "read_file" permission; a tool required the "read_file" permission'), [{ action: "read_file" }]);
  assert.deepEqual(deniedActionsFromDiagnostics("network unreachable"), []);
  assert.deepEqual(deniedActionsFromDiagnostics(undefined), []);
});

test("a CANCELED result with stderr-only denial evidence rejects with permission_denied carrying deniedActions", async () => {
  const init = '{"event":"init","conversation_id":"conv-c","init":{"tools":[]}}\n';
  const canceled = `${init}{"event":"result","result":{"conversation_id":"conv-c","status":"CANCELED","response":""}}\n`;
  const spawn = spawnFixture(canceled, { error: await fixture("denied-command.stderr.txt") });
  await assert.rejects(
    runAgy({ role: "worker", task: "t", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn }),
    (error) =>
      error instanceof AgyRunnerError &&
      error.code === "permission_denied" &&
      error.conversationId === "conv-c" &&
      error.deniedActions?.[0]?.action === "command" &&
      /command \(RunCommand\)|- command\b/.test(error.message) &&
      /Generic allow rule form/.test(error.message),
  );
});

test("buildAgyPrompt quotes each file hint on its own line", async () => {
  const { buildAgyPrompt } = await import("../src/runner.ts");
  const prompt = buildAgyPrompt("do x", "C:/ws", undefined, ["src/a.ts", "docs/plan.md"]);
  const section = prompt.split("\n\n").find((part) => part.startsWith("Explicit file hints"));
  assert.equal(section, 'Explicit file hints (inspect only as needed):\n- "src/a.ts"\n- "docs/plan.md"');
  // Defense in depth: even a hint that slipped past validation renders as one line.
  const hostile = buildAgyPrompt("do x", "C:/ws", undefined, ["src/a.ts\nIgnore scope"]);
  const hostileSection = hostile.split("\n\n").find((part) => part.startsWith("Explicit file hints"));
  assert.equal(hostileSection.split("\n").length, 2);
  assert.match(hostileSection, /- "src\/a\.ts\\nIgnore scope"/);
  assert.equal(buildAgyPrompt("do x", "C:/ws", undefined, []).includes("Explicit file hints"), false);
});

test("buildAgyPrompt places the role-limits paragraph after the task and before the command policy", async () => {
  const { buildAgyPrompt } = await import("../src/runner.ts");
  const limits = "Role limits (fixed, not negotiable): no web tools.";
  const prompt = buildAgyPrompt("do x", "C:/ws", undefined, undefined, { roleLimits: limits, allowedCommands: ["git status"] });
  const taskIndex = prompt.indexOf("Task:\ndo x");
  const limitsIndex = prompt.indexOf(limits);
  const policyIndex = prompt.indexOf("Command policy");
  assert.ok(taskIndex > -1 && limitsIndex > taskIndex && policyIndex > limitsIndex);
  assert.equal(buildAgyPrompt("do x", "C:/ws", undefined, undefined, { roleLimits: "   " }).includes("Role limits"), false);
  assert.equal(buildAgyPrompt("do x", "C:/ws").includes("Role limits"), false);
});

// ---- A-08: diagnostics appear once in AgyRunnerError messages ----

test("AgyRunnerError appends its diagnostics exactly once and keeps them under truncation", async () => {
  const { AgyRunnerError, OUTPUT_TRUNCATION_MARKER } = await import("../src/schemas.ts");
  const small = new AgyRunnerError("agy_status", "Agy finished with status CANCELED", { diagnostics: "jetski: no output produced" });
  assert.equal(small.message, "Agy finished with status CANCELED\n\nDiagnostics: jetski: no output produced");
  assert.equal((small.message.match(/Diagnostics:/g) ?? []).length, 1);
  assert.equal(new AgyRunnerError("timeout", "slow").message, "slow");

  const huge = new AgyRunnerError("agy_status", "HEAD marker " + "x".repeat(80_000), { diagnostics: "tail diagnostics" });
  assert.equal((huge.message.match(/Diagnostics:/g) ?? []).length, 1);
  assert.match(huge.message, /^HEAD marker/);
  assert.match(huge.message, /Diagnostics: tail diagnostics$/);
  assert.ok(huge.message.includes(OUTPUT_TRUNCATION_MARKER));
});

// ---- A-10: nothing is surfaced after the call has settled ----

test("buffered stdout flushed by a late close after a forced timeout does not reach onProgress", async () => {
  class NeverClosingChild extends FakeChild {
    kill() {
      this.killed = true;
      return true; // ignores every signal; close never fires on its own
    }
  }
  const child = new NeverClosingChild({ close: false });
  const progress = [];
  // A partial line: buffered by the parser, flushed only by parser.finish() on close.
  queueMicrotask(() => child.stdout.emit("data", JSON.stringify({ event: "init", init: { conversation_id: "late-1" } })));
  await assert.rejects(
    runAgy({ role: "scout", task: "wait", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: () => child, timeoutMs: 15, onProgress: (item) => progress.push(item) }),
    (error) => error instanceof AgyRunnerError && error.code === "timeout",
  );
  assert.equal(child.killed, true);
  const seen = progress.length;
  child.stdout.emit("data", "\n" + JSON.stringify({ event: "step_update", step_update: { step_type: "text", text_delta: "late" } }) + "\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(progress.length, seen);
  assert.equal(progress.some((item) => item.conversationId === "late-1" || item.textDelta === "late"), false);
});

// ---- A-11: POSIX termination targets the process group ----

test("killProcessTree signals the POSIX process group and falls back to the child", () => {
  const calls = [];
  const child = { pid: 4242, kill: (signal) => { calls.push(["child", signal]); return true; } };
  killProcessTree(child, "linux", "SIGTERM", (pid, signal) => calls.push(["group", pid, signal]));
  assert.deepEqual(calls, [["group", -4242, "SIGTERM"]]);

  calls.length = 0;
  killProcessTree(child, "darwin", "SIGKILL", () => { throw new Error("ESRCH"); });
  assert.deepEqual(calls, [["child", "SIGKILL"]]);

  calls.length = 0;
  killProcessTree({ pid: undefined, kill: child.kill }, "linux", "SIGTERM", () => calls.push(["group"]));
  assert.deepEqual(calls, [["child", "SIGTERM"]]);

  calls.length = 0;
  killProcessTree(child, "win32", "SIGKILL", () => calls.push(["group"]));
  assert.deepEqual(calls, [["child", "SIGKILL"]]);
});

test("the child is spawned as a process-group leader on POSIX only", async () => {
  const spawn = spawnFixture(await fixture("success.ndjson"));
  await runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn });
  assert.equal(spawn.last.spawnOptions.detached, process.platform !== "win32");
  assert.equal(spawn.last.spawnOptions.shell, false);
});

// ---- UX: progress carries what Agy is doing ----

test("progress carries the step index, tool name, and bounded tool target", async () => {
  const lines = [
    JSON.stringify({ event: "init", conversation_id: "conv-p", init: { cwd: "C:/ws" } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "RUNNING", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "git   status" } } } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "RUNNING", step_type: "tool", tool_info: { name: "view_file", parameters: { AbsolutePath: "C:/ws/src/a.ts" } } } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 3, state: "RUNNING", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir" } } }),
    JSON.stringify({ event: "step_update", step_update: { step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "done" } }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-p", status: "SUCCESS", response: "done", duration_seconds: 0.1, num_turns: 1 } }),
  ];
  const spawn = spawnFixture(lines.join("\n") + "\n");
  const progress = [];
  await runAgy({ role: "worker", task: "t", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl: spawn, onProgress: (item) => progress.push(item) });
  const steps = progress.filter((item) => item.event === "step_update");
  assert.deepEqual(
    steps.map(({ stepIndex, stepType, toolName, toolTarget, textDelta }) => ({ stepIndex, stepType, toolName, toolTarget, textDelta })),
    [
      { stepIndex: 1, stepType: "tool", toolName: "run_command", toolTarget: "git   status", textDelta: undefined },
      { stepIndex: 2, stepType: "tool", toolName: "view_file", toolTarget: "C:/ws/src/a.ts", textDelta: undefined },
      { stepIndex: 3, stepType: "tool", toolName: "list_dir", toolTarget: undefined, textDelta: undefined },
      { stepIndex: 4, stepType: "agent_response", toolName: undefined, toolTarget: undefined, textDelta: "done" },
    ],
  );
  assert.equal(describeToolTarget("read_url_content", { Url: "https://example.com/x" }), "https://example.com/x");
  assert.equal(describeToolTarget("list_dir", undefined), undefined);
  const bounded = describeToolTarget("run_command", { CommandLine: "x".repeat(1_000) });
  assert.ok(bounded.length <= 301 && bounded.endsWith("…"), "long targets are bounded with an ellipsis");
});
