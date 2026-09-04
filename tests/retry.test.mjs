import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgyRunnerError } from "../src/schemas.ts";
import { formatModelVisibleResponse, runAgy } from "../src/runner.ts";
import { buildDenialFollowUpTask, runAgyWithDenialRetry, shouldRetryAfterDenial } from "../src/retry.ts";

const fixture = async (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const FAKE_EXECUTABLE = process.platform === "win32" ? "C:\\SyntheticAgy\\agy-test.exe" : "/synthetic/agy-test";

const DENIED = [{ toolName: "run_command", summary: "echo probe", message: "user denied permission to run command", suggestedRule: "command(echo probe)" }];

function summary(overrides = {}) {
  return {
    role: "worker",
    cwd: process.cwd(),
    status: "SUCCESS",
    response: "",
    conversationId: "conv-1",
    durationMs: 10,
    ...overrides,
  };
}

function sequencedRun(results) {
  const calls = [];
  const run = async (options) => {
    calls.push(options);
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  run.calls = calls;
  return run;
}

test("shouldRetryAfterDenial requires a resumable, output-less denial", () => {
  assert.equal(shouldRetryAfterDenial({ escalationRequired: true, response: "", conversationId: "c" }), true);
  assert.equal(shouldRetryAfterDenial({ escalationRequired: true, response: "   \n", conversationId: "c" }), true);
  assert.equal(shouldRetryAfterDenial({ escalationRequired: true, response: "did the rest", conversationId: "c" }), false);
  assert.equal(shouldRetryAfterDenial({ escalationRequired: false, response: "", conversationId: "c" }), false);
  assert.equal(shouldRetryAfterDenial({ escalationRequired: true, response: "", conversationId: undefined }), false);
});

test("buildDenialFollowUpTask names the denied calls and forbids retries of them", () => {
  const text = buildDenialFollowUpTask(DENIED);
  assert.match(text, /^Policy notice from the parent orchestrator/);
  assert.match(text, /- run_command `echo probe`/);
  assert.match(text, /Do not call them again/);
  assert.match(text, /Decisions needed/);
  assert.match(buildDenialFollowUpTask([]), /exact call was not reported/);
});

test("returns a clean first attempt untouched", async () => {
  const run = sequencedRun([summary({ response: "done" })]);
  const result = await runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), runImpl: run });
  assert.equal(result.response, "done");
  assert.equal(result.retry, undefined);
  assert.equal(run.calls.length, 1);
});

test("continues the same conversation once after an output-less SUCCESS denial", async () => {
  const run = sequencedRun([
    summary({ escalationRequired: true, deniedTools: DENIED, diagnostics: "first notice" }),
    summary({ response: "finished without the command", conversationId: "conv-1", numTurns: 2 }),
  ]);
  const result = await runAgyWithDenialRetry({ role: "worker", task: "original", cwd: process.cwd(), context: "ctx", files: ["a.md"], runImpl: run });
  assert.equal(run.calls.length, 2);
  const second = run.calls[1];
  assert.equal(second.conversationId, "conv-1");
  assert.equal(second.context, undefined);
  assert.equal(second.files, undefined);
  assert.match(second.task, /Policy notice/);
  assert.match(second.task, /run_command `echo probe`/);
  assert.equal(second.role, "worker");
  assert.equal(result.response, "finished without the command");
  assert.equal(result.retry.attempted, true);
  assert.equal(result.retry.firstAttemptStatus, "SUCCESS");
  assert.deepEqual(result.retry.firstAttemptDeniedTools, DENIED);
  assert.match(result.retry.firstAttemptNotice, /command\(echo probe\)/);
  // The owner-facing notice survives a clean continuation.
  assert.match(result.diagnostics, /command\(echo probe\)/);
  const visible = formatModelVisibleResponse(result);
  assert.match(visible, /finished without the command/);
  assert.match(visible, /\[Agy auto-retry\]/);
  assert.match(visible, /suggested rule: command\(echo probe\)/);
});

test("continues after a permission_denied rejection that carries a conversation ID", async () => {
  const failure = new AgyRunnerError("permission_denied", "ESCALATION REQUIRED: denied", {
    status: "CANCELED",
    conversationId: "conv-9",
    deniedTools: DENIED,
  });
  const run = sequencedRun([failure, summary({ response: "recovered", conversationId: "conv-9" })]);
  const result = await runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), runImpl: run });
  assert.equal(run.calls[1].conversationId, "conv-9");
  assert.equal(result.response, "recovered");
  assert.equal(result.retry.firstAttemptStatus, "CANCELED");
});

test("does not retry without a conversation ID, on other error codes, or when disabled", async () => {
  const noConversation = new AgyRunnerError("permission_denied", "denied", { status: "CANCELED", deniedTools: DENIED });
  await assert.rejects(
    runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), runImpl: sequencedRun([noConversation]) }),
    (error) => error === noConversation,
  );
  const other = new AgyRunnerError("timeout", "slow", { conversationId: "conv-1" });
  await assert.rejects(
    runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), runImpl: sequencedRun([other]) }),
    (error) => error === other,
  );
  const disabled = sequencedRun([summary({ escalationRequired: true, deniedTools: DENIED })]);
  const result = await runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), runImpl: disabled, autoRetry: false });
  assert.equal(disabled.calls.length, 1);
  assert.equal(result.retry, undefined);
});

test("does not retry when the denied attempt still produced substantive output", async () => {
  const run = sequencedRun([summary({ escalationRequired: true, deniedTools: DENIED, response: "Changed files: none. Decisions needed: ..." })]);
  const result = await runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), runImpl: run });
  assert.equal(run.calls.length, 1);
  assert.equal(result.retry, undefined);
});

test("a failing continuation keeps the first attempt's notice", async () => {
  const run = sequencedRun([
    summary({ escalationRequired: true, deniedTools: DENIED }),
    new AgyRunnerError("timeout", "Agy delegation exceeded 5ms", { conversationId: "conv-1" }),
  ]);
  await assert.rejects(
    runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), runImpl: run }),
    (error) =>
      error instanceof AgyRunnerError &&
      error.code === "timeout" &&
      /command\(echo probe\)/.test(error.message) &&
      /The continuation also failed/.test(error.message) &&
      error.conversationId === "conv-1",
  );
});

// ---- integration through the real runner with a sequenced fake spawn ----

class FakeChild extends EventEmitter {
  constructor({ output = "", error = "" } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
    this.stdin = new EventEmitter();
    this.stdin.end = (payload) => { this.stdinPayload = payload; };
    setTimeout(() => {
      if (output) this.stdout.emit("data", output);
      if (error) this.stderr.emit("data", error);
      this.emit("close", 0, null);
    }, 0);
  }
  kill() { return true; }
}

test("runAgy + retry: the second spawn resumes with --conversation and a policy notice", async () => {
  const denied = await fixture("denied-command.ndjson");
  const stderr = await fixture("denied-command.stderr.txt");
  const success = await fixture("success.ndjson");
  const spawns = [];
  const spawnImpl = (command, args, options) => {
    spawns.push({ command, args, options });
    const child = new FakeChild(spawns.length === 1 ? { output: denied, error: stderr } : { output: success });
    spawns[spawns.length - 1].child = child;
    return child;
  };
  const result = await runAgyWithDenialRetry({
    role: "worker",
    task: "run echo probe",
    cwd: process.cwd(),
    executable: FAKE_EXECUTABLE,
    spawnImpl,
    allowedCommands: ["git status"],
    runImpl: runAgy,
  });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].args.includes("--conversation"), false);
  const conversationIndex = spawns[1].args.indexOf("--conversation");
  assert.ok(conversationIndex > -1);
  assert.equal(spawns[1].args[conversationIndex + 1], "a0ecb8ba-6e92-47d2-aaa0-5a63c248ab64");
  const secondPrompt = JSON.parse(spawns[1].child.stdinPayload).message.content;
  assert.match(secondPrompt, /Policy notice from the parent orchestrator/);
  assert.match(secondPrompt, /run_command `echo probe`/);
  assert.match(secondPrompt, /Command policy/);
  assert.equal(result.response, "hello world\n");
  assert.equal(result.retry.attempted, true);
  assert.equal(result.retry.firstAttemptDeniedTools[0].suggestedRule, "command(echo probe)");
});

test("a CANCELED run whose only denial evidence is stderr still retries with the permission category", async () => {
  const init = '{"event":"init","conversation_id":"conv-c","init":{"tools":[]}}\n';
  const canceled = `${init}{"event":"result","result":{"conversation_id":"conv-c","status":"CANCELED","response":""}}\n`;
  const stderr = await fixture("denied-command.stderr.txt");
  const success = await fixture("success.ndjson");
  const spawns = [];
  const spawnImpl = (command, args) => {
    spawns.push({ args });
    const child = new FakeChild(spawns.length === 1 ? { output: canceled, error: stderr } : { output: success });
    spawns[spawns.length - 1].child = child;
    return child;
  };
  const result = await runAgyWithDenialRetry({ role: "worker", task: "t", cwd: process.cwd(), executable: FAKE_EXECUTABLE, spawnImpl });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].args[spawns[1].args.indexOf("--conversation") + 1], "conv-c");
  const secondPrompt = JSON.parse(spawns[1].child.stdinPayload).message.content;
  assert.match(secondPrompt, /the "command" permission/);
  assert.match(secondPrompt, /run_command \(any shell command\)/);
  assert.deepEqual(result.retry.firstAttemptDeniedActions, [{ action: "command" }]);
  assert.equal(result.retry.firstAttemptStatus, "CANCELED");
  assert.match(formatModelVisibleResponse(result), /command permission/);
});
