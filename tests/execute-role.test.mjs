// A-07: end-to-end behaviour of the role-tool execution path with a fake Pi
// context and injected runner/settings/preflight functions. No model, no
// process spawn.
import assert from "node:assert/strict";
import test from "node:test";

import { PROGRESS_THROTTLE_MS, STATUS_KEY, executeRole } from "../src/execute-role.ts";
import { formatProgress } from "../src/format.ts";
import { ROLE_CONFIGS } from "../src/roles.ts";

function makeCtx({ hasUI = true, confirmResult = true } = {}) {
  const confirms = [];
  const statuses = [];
  return {
    ctx: {
      cwd: process.cwd(),
      hasUI,
      ui: {
        confirm: async (title, message) => {
          confirms.push({ title, message });
          return confirmResult;
        },
        setStatus: (key, text) => statuses.push({ key, text }),
      },
    },
    confirms,
    statuses,
  };
}

const covered = { source: "settings", readCoveringRule: "read_file(C:/ws)", writeCoveringRule: "write_file(C:/ws)" };
const readOnlyCovered = { source: "settings", readCoveringRule: "read_file(C:/ws)" };
const uncovered = { source: "settings" };
const unavailable = { source: "unavailable", reason: "ENOENT" };

function makeDeps({ coverage = covered, commands = { source: "settings", commands: ["git status"] }, run } = {}) {
  const calls = { runRole: [], loadAllowedCommands: 0, preflight: [] };
  const deps = {
    preflightCwdCoverage: async (args) => {
      calls.preflight.push(args);
      return coverage;
    },
    loadAllowedCommands: async () => {
      calls.loadAllowedCommands += 1;
      return commands;
    },
    runRole: async (options) => {
      calls.runRole.push(options);
      if (run) return run(options);
      return { role: options.role, cwd: options.cwd, status: "SUCCESS", response: `${options.role} done`, conversationId: "conv-1" };
    },
  };
  return { deps, calls };
}

test("worker is denied headlessly before any spawn, settings read, or status change", async () => {
  const { ctx, confirms, statuses } = makeCtx({ hasUI: false });
  const { deps, calls } = makeDeps();
  await assert.rejects(executeRole("worker", { task: "edit" }, undefined, undefined, ctx, {}, deps), /denied when Pi has no interactive UI/);
  assert.equal(calls.runRole.length, 0);
  assert.equal(calls.loadAllowedCommands, 0);
  assert.equal(calls.preflight.length, 1, "preflight runs before the gate");
  assert.deepEqual(confirms, []);
  assert.deepEqual(statuses, []);
});

test("a rejected write confirmation stops the call before the runner", async () => {
  const { ctx, confirms } = makeCtx({ confirmResult: false });
  const { deps, calls } = makeDeps();
  await assert.rejects(executeRole("delegate", { task: "edit" }, undefined, undefined, ctx, {}, deps), /rejected by the user/);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].title, "Allow Agy delegate writes?");
  assert.equal(calls.runRole.length, 0);
});

test("a confirmed worker call reaches the runner with the role's fixed model, mode, policy, and limits", async () => {
  const { ctx, confirms, statuses } = makeCtx();
  const { deps, calls } = makeDeps();
  const updates = [];
  const controller = new AbortController();
  const result = await executeRole(
    "worker",
    { task: "edit plan", context: "brief", files: ["docs/plan.md"], timeout_ms: 45_000, auto_retry: true },
    controller.signal,
    (update) => updates.push(update),
    ctx,
    {},
    deps,
  );
  assert.equal(confirms.length, 1);
  assert.equal(calls.loadAllowedCommands, 1);
  assert.equal(calls.runRole.length, 1);
  const options = calls.runRole[0];
  assert.equal(options.role, "worker");
  assert.equal(options.task, "edit plan");
  assert.equal(options.context, "brief");
  assert.deepEqual(options.files, ["docs/plan.md"]);
  assert.equal(options.cwd, process.cwd());
  assert.equal(options.timeoutMs, 45_000);
  assert.equal(options.autoRetry, true);
  assert.equal(options.model, ROLE_CONFIGS.worker.model);
  assert.equal(options.mode, "accept-edits");
  assert.deepEqual(options.allowedCommands, ["git status"]);
  assert.equal(options.roleLimits, ROLE_CONFIGS.worker.degradation);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.conversationId, undefined);
  assert.equal(result.content[0].text, "worker done");
  assert.equal(result.details.status, "SUCCESS");
  assert.equal(result.details.conversationId, "conv-1");
  // Status line: starting, then cleared in finally.
  assert.deepEqual(statuses[0], { key: STATUS_KEY, text: "worker · starting" });
  assert.deepEqual(statuses.at(-1), { key: STATUS_KEY, text: undefined });
  assert.deepEqual(updates, []);
});

test("progress is forwarded to Pi as partial RUNNING updates with elapsed time, step, and tool target", async () => {
  const { ctx, statuses } = makeCtx();
  let clock = 10_000;
  const { deps } = makeDeps({
    run: (options) => {
      clock += 500; // 0:00
      options.onProgress({ event: "init", conversationId: "conv-2" });
      clock += 61_000; // 1:01
      options.onProgress({ event: "step_update", stepIndex: 3, stepType: "tool", toolName: "grep_search", toolTarget: "C:/ws/src   deep" });
      clock += 1_000; // 1:02
      options.onProgress({ event: "step_update", stepIndex: 4, stepType: "agent_response", textDelta: "listing   files" });
      return { role: "scout", cwd: options.cwd, status: "SUCCESS", response: "scout done" };
    },
  });
  deps.now = () => clock;
  const updates = [];
  await executeRole("scout", { task: "look" }, undefined, (update) => updates.push(update), ctx, {}, deps);
  assert.deepEqual(
    updates.map((update) => update.content[0].text),
    ["scout · 0:00 · working", "scout · 1:01 · step 3 · grep_search C:/ws/src deep", "scout · 1:02 · step 4 · agent_response: listing files"],
  );
  assert.deepEqual(updates[1].details, { role: "scout", cwd: process.cwd(), status: "RUNNING", partial: true, stepType: "tool" });
  assert.deepEqual(statuses.map((entry) => entry.text), ["scout · starting", ...updates.map((update) => update.content[0].text), undefined]);
});

test("text-only deltas are throttled; tool steps always get through", async () => {
  const { ctx } = makeCtx({ hasUI: false });
  let clock = 0;
  const { deps } = makeDeps({
    coverage: readOnlyCovered,
    run: (options) => {
      const delta = (text) => options.onProgress({ event: "step_update", stepType: "agent_response", textDelta: text });
      delta("one"); // emitted (first)
      clock += 50;
      delta("two"); // dropped
      clock += 50;
      options.onProgress({ event: "step_update", stepType: "tool", toolName: "view_file", toolTarget: "a.ts", textDelta: "ignored" }); // emitted
      delta("three"); // dropped (100 ms since "one")
      clock += PROGRESS_THROTTLE_MS;
      delta("four"); // emitted
      return { role: "scout", cwd: options.cwd, status: "SUCCESS", response: "scout done" };
    },
  });
  deps.now = () => clock;
  const updates = [];
  await executeRole("scout", { task: "look" }, undefined, (update) => updates.push(update), ctx, {}, deps);
  assert.deepEqual(
    updates.map((update) => update.content[0].text),
    ["scout · 0:00 · agent_response: one", "scout · 0:00 · view_file a.ts", "scout · 0:00 · agent_response: four"],
  );
});

test("read-only roles skip the write gate and never load the command policy", async () => {
  const { ctx, confirms } = makeCtx({ hasUI: false });
  const { deps, calls } = makeDeps({ coverage: readOnlyCovered });
  const result = await executeRole("scout", { task: "look" }, undefined, undefined, ctx, {}, deps);
  assert.deepEqual(confirms, []);
  assert.equal(calls.loadAllowedCommands, 0);
  assert.equal(calls.runRole[0].allowedCommands, undefined);
  assert.equal(calls.runRole[0].mode, "default");
  assert.equal(result.content[0].text, "scout done");
});

test("preflight refuses a local-file role when settings cover nothing, before confirmation", async () => {
  const { ctx, confirms } = makeCtx();
  const { deps, calls } = makeDeps({ coverage: uncovered });
  await assert.rejects(executeRole("worker", { task: "edit" }, undefined, undefined, ctx, {}, deps), /Agy preflight: no read_file\(\.\.\.\) allow rule in Agy settings covers/);
  assert.deepEqual(confirms, []);
  assert.equal(calls.runRole.length, 0);
});

test("preflight notices are prefixed to the response when settings are unavailable or writes are uncovered", async () => {
  const { ctx } = makeCtx();
  const unavailableDeps = makeDeps({ coverage: unavailable, commands: { source: "unavailable", reason: "EACCES" } });
  const first = await executeRole("worker", { task: "edit" }, undefined, undefined, ctx, {}, unavailableDeps.deps);
  assert.match(first.content[0].text, /^\[Agy preflight\] Agy settings unavailable \(ENOENT\); cwd coverage was not checked\.\n\[Agy settings notice\] Command allow rules unavailable \(EACCES\); worker was told to run no commands\.\n\nworker done$/);
  assert.equal(unavailableDeps.calls.runRole[0].allowedCommands, undefined);

  const noWrite = makeDeps({ coverage: readOnlyCovered });
  const second = await executeRole("delegate", { task: "edit" }, undefined, undefined, ctx, {}, noWrite.deps);
  assert.match(second.content[0].text, /^\[Agy preflight\] No write_file\(\.\.\.\) allow rule covers .*; delegate can read but every write will be auto-denied\.\n\ndelegate done$/);

  const scoutNoWrite = makeDeps({ coverage: readOnlyCovered });
  const third = await executeRole("scout", { task: "look" }, undefined, undefined, ctx, {}, scoutNoWrite.deps);
  assert.equal(third.content[0].text, "scout done", "read-only roles get no write-rule notice");
});

test("skip_preflight and conversation_id bypass the preflight; auto_retry false is passed through", async () => {
  const { ctx } = makeCtx();
  const skip = makeDeps({ coverage: uncovered });
  await executeRole("worker", { task: "edit", skip_preflight: true, auto_retry: false }, undefined, undefined, ctx, {}, skip.deps);
  assert.equal(skip.calls.preflight.length, 0);
  assert.equal(skip.calls.runRole[0].autoRetry, false);

  const resume = makeDeps({ coverage: uncovered });
  await executeRole("worker", { task: "continue", conversation_id: "conv-9" }, undefined, undefined, ctx, {}, resume.deps);
  assert.equal(resume.calls.preflight.length, 0);
  assert.equal(resume.calls.runRole[0].conversationId, "conv-9");
});

test("researcher skips the preflight, rejects file hints, and gates explicit context behind its own confirmation", async () => {
  const { ctx, confirms } = makeCtx();
  const { deps, calls } = makeDeps({ coverage: uncovered });
  await assert.rejects(executeRole("researcher", { task: "find", files: ["a.md"] }, undefined, undefined, ctx, {}, deps), /does not accept file hints/);
  assert.equal(calls.preflight.length, 0);

  await executeRole("researcher", { task: "find", context: "secret-free brief" }, undefined, undefined, ctx, {}, deps);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].title, "Allow Agy researcher context?");
  assert.match(confirms[0].message, /Explicit context \(17 characters\)/);
  assert.equal(calls.runRole[0].context, "secret-free brief");
  assert.equal(calls.runRole[0].mode, "default");

  const headless = makeCtx({ hasUI: false });
  const headlessDeps = makeDeps();
  await assert.rejects(executeRole("researcher", { task: "find", context: "brief" }, undefined, undefined, headless.ctx, {}, headlessDeps.deps), /denied in headless mode/);
  assert.equal(headlessDeps.calls.runRole.length, 0);
  // Researcher without context needs no confirmation at all.
  await executeRole("researcher", { task: "find" }, undefined, undefined, headless.ctx, {}, headlessDeps.deps);
  assert.equal(headlessDeps.calls.runRole.length, 1);
});

test("skipWriteGate suppresses the second confirmation only when Pi has a UI", async () => {
  const withUI = makeCtx();
  const uiDeps = makeDeps();
  await executeRole("worker", { task: "apply" }, undefined, undefined, withUI.ctx, { skipWriteGate: true }, uiDeps.deps);
  assert.deepEqual(withUI.confirms, []);
  assert.equal(uiDeps.calls.runRole.length, 1);

  const headless = makeCtx({ hasUI: false });
  const headlessDeps = makeDeps();
  await assert.rejects(executeRole("worker", { task: "apply" }, undefined, undefined, headless.ctx, { skipWriteGate: true }, headlessDeps.deps), /denied when Pi has no interactive UI/);
  assert.equal(headlessDeps.calls.runRole.length, 0);
});

test("input validation fails closed before preflight, gate, and runner", async () => {
  const { ctx, confirms } = makeCtx();
  const { deps, calls } = makeDeps();
  await assert.rejects(executeRole("worker", { task: "" }, undefined, undefined, ctx, {}, deps), /non-empty/);
  await assert.rejects(executeRole("worker", { task: "x", cwd: "../outside-workspace" }, undefined, undefined, ctx, {}, deps), /outside the allowed workspace|ENOENT|no such file/);
  await assert.rejects(executeRole("worker", { task: "x", files: ["../sibling.txt"] }, undefined, undefined, ctx, {}, deps), /outside the selected workspace/);
  await assert.rejects(executeRole("worker", { task: "x", conversation_id: "bad id!" }, undefined, undefined, ctx, {}, deps), /unsupported characters/);
  assert.equal(calls.preflight.length, 0);
  assert.deepEqual(confirms, []);
  assert.equal(calls.runRole.length, 0);
});

test("a runner failure propagates unchanged and still clears the status line", async () => {
  const { ctx, statuses } = makeCtx();
  const failure = new Error("ESCALATION REQUIRED: Agy ended the run with status CANCELED");
  const { deps } = makeDeps({ run: () => { throw failure; } });
  await assert.rejects(executeRole("worker", { task: "edit" }, undefined, undefined, ctx, {}, deps), (error) => error === failure);
  assert.deepEqual(statuses.at(-1), { key: STATUS_KEY, text: undefined });
});

test("escalation diagnostics from the runner are rendered into the model-visible text", async () => {
  const { ctx } = makeCtx({ hasUI: false });
  const { deps } = makeDeps({
    coverage: readOnlyCovered,
    run: (options) => ({ role: "scout", cwd: options.cwd, status: "SUCCESS", response: "", diagnostics: "[Agy permission denial] read_file", escalationRequired: true }),
  });
  const result = await executeRole("scout", { task: "look" }, undefined, undefined, ctx, {}, deps);
  assert.match(result.content[0].text, /\[ESCALATION REQUIRED: Agy permission\/approval notice\]\n\[Agy permission denial\] read_file/);
  assert.equal(result.details.escalationRequired, true);
});

test("formatProgress collapses whitespace and keeps only the tail of a long delta", () => {
  assert.equal(formatProgress({ role: "worker" }), "worker · working");
  assert.equal(formatProgress({ role: "worker", stepType: "tool" }), "worker · tool");
  const long = "a".repeat(200) + " end";
  const text = formatProgress({ role: "worker", stepType: "text", textDelta: long });
  assert.ok(text.endsWith(" end"));
  assert.ok(text.length <= "worker · text: ".length + 80);
});
