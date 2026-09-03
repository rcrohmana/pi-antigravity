import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgyRunnerError } from "../src/schemas.ts";
import { NdjsonParser, buildAgyArgs, classifyDiagnostics, formatModelVisibleResponse, parseNdjsonLine, runAgy, resolveAgyExecutable } from "../src/runner.ts";

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
  const spawn = (_command, args, spawnOptions) => {
    child = new FakeChild({ output: text, ...options });
    spawn.last = { args, spawnOptions };
    return child;
  };
  spawn.child = () => child;
  return spawn;
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
    executable: "agy-test",
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
    message: { content: "Task:\ninspect" },
  });
});

test("fails on Agy error status and exposes stderr diagnostics", async () => {
  const spawn = spawnFixture(await fixture("error.ndjson"), { error: "permission denied: run_command requires approval\n" });
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: "agy-test", spawnImpl: spawn }),
    (error) => error instanceof AgyRunnerError && error.code === "agy_status" && error.status === "ERROR" && error.message.includes("permission denied"),
  );
});

test("fails when terminal result is missing", async () => {
  const spawn = spawnFixture(await fixture("missing-result.ndjson"));
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: "agy-test", spawnImpl: spawn }),
    (error) => error instanceof AgyRunnerError && error.code === "missing_result",
  );
});

test("surfaces successful-run permission diagnostics as escalation", async () => {
  const spawn = spawnFixture(await fixture("success.ndjson"), { error: "permission denied: run_command requires approval\n" });
  const result = await runAgy({ role: "worker", task: "inspect", cwd: process.cwd(), executable: "agy-test", spawnImpl: spawn });
  assert.equal(result.escalationRequired, true);
  assert.match(formatModelVisibleResponse(result), /ESCALATION REQUIRED/);
  assert.match(formatModelVisibleResponse(result), /permission denied/);
});

test("fails on malformed stream and attempts cleanup", async () => {
  const spawn = spawnFixture(await fixture("malformed.ndjson"));
  await assert.rejects(
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: "agy-test", spawnImpl: spawn }),
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
    runAgy({ role: "scout", task: "inspect", cwd: process.cwd(), executable: "agy-test", spawnImpl: () => child }),
    (error) => error instanceof AgyRunnerError && error.code === "protocol_error",
  );
  assert.ok(child.kills >= 2);
});

test("already-aborted signal prevents spawn and stdin", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(
    runAgy({ role: "scout", task: "must not run", cwd: process.cwd(), executable: "agy-test", signal: controller.signal, spawnImpl: () => { spawned = true; throw new Error("spawned"); } }),
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
    runAgy({ role: "scout", task: "send", cwd: process.cwd(), executable: "agy-test", spawnImpl: spawn }),
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
    runAgy({ role: "scout", task: "wait", cwd: process.cwd(), executable: "agy-test", spawnImpl: neverSpawn, timeoutMs: 15 }),
    (error) => error instanceof AgyRunnerError && error.code === "timeout",
  );
  assert.equal(timeoutChild.killed, true);

  const controller = new AbortController();
  let abortChild;
  const abortSpawn = () => {
    abortChild = new FakeChild({ close: false });
    return abortChild;
  };
  const pending = runAgy({ role: "scout", task: "wait", cwd: process.cwd(), executable: "agy-test", spawnImpl: abortSpawn, signal: controller.signal });
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
    runAgy({ role: "scout", task: "error", cwd: process.cwd(), executable: "agy-test", spawnImpl: spawnFixture(output) }),
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

