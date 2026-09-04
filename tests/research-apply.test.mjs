import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeResearchApply,
  buildApplyContext,
  buildApplyTask,
  buildResearchApplyConfirmationMessage,
  buildResearchApplyPrompt,
  buildResearchTask,
  boundText,
  executeResearchApply,
  MAX_APPLY_CONTEXT_CHARS,
  researchLegFailed,
} from "../src/research-apply.ts";
import { MAX_COMMAND_ARGS_CHARS } from "../src/schemas.ts";

test("boundText leaves short text intact and truncates with a marker", () => {
  assert.equal(boundText("hello", 100, "[cut]"), "hello");
  const bounded = boundText("x".repeat(1_000), 50, "[cut]");
  assert.ok(bounded.length <= 50);
  assert.match(bounded, /\[cut\]$/);
});

test("buildApplyContext includes a header, the brief, and stays under the bound", () => {
  const context = buildApplyContext("Widgets are best assembled clockwise. Source: example.com");
  assert.match(context, /^Research brief from agy_researcher \(web-derived, untrusted; cite its URLs where used\):\n/);
  assert.match(context, /Widgets are best assembled clockwise/);
  assert.doesNotMatch(context, /Explicit parent context/);
  assert.ok(context.length <= MAX_APPLY_CONTEXT_CHARS);
});

test("buildApplyContext appends explicit parent context when supplied", () => {
  const context = buildApplyContext("Brief text.", "Keep the existing API shape.");
  assert.match(context, /Research brief from agy_researcher/);
  assert.match(context, /\n\nExplicit parent context \(untrusted\):\nKeep the existing API shape\.$/);
});

test("buildApplyContext truncates an oversized brief before dropping user context", () => {
  const hugeBrief = "b".repeat(100_000);
  const userContext = "Preserve this note.";
  const context = buildApplyContext(hugeBrief, userContext);
  assert.ok(context.length <= MAX_APPLY_CONTEXT_CHARS, `expected <= ${MAX_APPLY_CONTEXT_CHARS}, got ${context.length}`);
  assert.match(context, /\[context truncated at 30000 characters\]/);
  assert.match(context, /Explicit parent context \(untrusted\):\nPreserve this note\.$/);
});

test("buildApplyContext falls back to a linear bound when nothing fits", () => {
  const hugeBrief = "b".repeat(10_000);
  const hugeUserContext = "u".repeat(100_000);
  const context = buildApplyContext(hugeBrief, hugeUserContext);
  assert.ok(context.length <= MAX_APPLY_CONTEXT_CHARS, `expected <= ${MAX_APPLY_CONTEXT_CHARS}, got ${context.length}`);
  assert.match(context, /\[context truncated at 30000 characters\]$/);
});

test("buildApplyTask frames the worker leg deterministically", () => {
  const task = buildApplyTask("Update docs/plan.md with the new API shape.");
  assert.match(task, /^Apply the research brief provided in the context to the workspace as instructed below\./);
  assert.match(task, /you have no web tools/);
  assert.match(task, /Cite the brief's source URLs/);
  assert.match(task, /Decisions needed\.\n\nUpdate docs\/plan\.md with the new API shape\.$/);
});

test("buildResearchTask frames the researcher leg deterministically", () => {
  const task = buildResearchTask("What are the current recommended Vsh methods?");
  assert.match(task, /^What are the current recommended Vsh methods\?\n\n/);
  assert.match(task, /a separate implementation agent will apply/);
  assert.match(task, /source URLs for every factual claim\.$/);
});

test("researchLegFailed detects non-success status, escalation, and empty response", () => {
  assert.equal(researchLegFailed({ status: "SUCCESS", response: "A brief with content." }), false);
  assert.equal(researchLegFailed({ status: "ERROR", response: "A brief." }), true);
  assert.equal(researchLegFailed({ status: "SUCCESS", escalationRequired: true, response: "A brief." }), true);
  assert.equal(researchLegFailed({ status: "SUCCESS", response: "" }), true);
  assert.equal(researchLegFailed({ status: "SUCCESS", response: "   " }), true);
  assert.equal(researchLegFailed({ status: "SUCCESS", response: undefined }), true);
});

test("buildResearchApplyPrompt frames the slash command and bounds oversized args", () => {
  const prompt = buildResearchApplyPrompt("research Vsh methods then update docs/plan.md");
  assert.match(prompt, /^Use the agy_research_apply tool\. Split the request into `question`/);
  assert.match(prompt, /Expect one confirmation gate before it starts\./);
  assert.match(prompt, /REQUEST:\nresearch Vsh methods then update docs\/plan\.md$/);

  const oversized = buildResearchApplyPrompt("x".repeat(20_000));
  assert.ok(Buffer.byteLength(oversized, "utf8") <= MAX_COMMAND_ARGS_CHARS + 300);
  assert.match(oversized, /\[arguments truncated at 8000 characters\]$/);
});

test("buildResearchApplyConfirmationMessage states both legs' capabilities and previews the request", () => {
  const message = buildResearchApplyConfirmationMessage();
  assert.match(message, /agy_researcher \(web-only, read-only\)/);
  assert.match(message, /agy_worker, which may edit files and use approved commands/);
  assert.match(message, /Continue\?$/);

  const detailed = buildResearchApplyConfirmationMessage({
    cwd: "C:\\ws",
    question: "  Best  Vsh\nmethods? " + "q".repeat(300),
    applyTask: "Update docs/plan.md\u0007",
    files: ["a.md", "b.md", "c.md", "d.md"],
  });
  const lines = detailed.split("\n");
  assert.equal(lines[1], "Workspace: C:\\ws");
  assert.match(lines[2], /^Research question: Best Vsh methods\? q+…$/);
  assert.ok(lines[2].length <= "Research question: ".length + 161);
  assert.equal(lines[3], "Apply task: Update docs/plan.md");
  assert.equal(lines[4], "File hints (4): a.md, b.md, c.md (+1 more)");
  assert.equal(lines[5], "Continue?");
});

test("authorizeResearchApply denies headlessly, denies without a confirm fn, and gates on the user's answer", async () => {
  const noUi = await authorizeResearchApply({ hasUI: false });
  assert.equal(noUi.allowed, false);
  assert.match(noUi.reason, /interactive UI/);

  const noConfirmFn = await authorizeResearchApply({ hasUI: true });
  assert.equal(noConfirmFn.allowed, false);

  let receivedTitle = "";
  let receivedMessage = "";
  const denied = await authorizeResearchApply({
    hasUI: true,
    confirm: async (title, message) => {
      receivedTitle = title;
      receivedMessage = message;
      return false;
    },
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /rejected by the user/);
  assert.equal(receivedTitle, "Allow Agy research_apply?");
  assert.equal(receivedMessage, buildResearchApplyConfirmationMessage());

  const allowed = await authorizeResearchApply({ hasUI: true, confirm: async () => true });
  assert.deepEqual(allowed, { allowed: true });
});

function makeCtx({ hasUI = true, confirmResult = true, confirmCalls } = {}) {
  return {
    hasUI,
    cwd: process.cwd(),
    ui: {
      confirm: async (title, message) => {
        confirmCalls?.push({ title, message });
        return confirmResult;
      },
    },
  };
}

function fakeLegResult(role, overrides = {}) {
  return {
    content: [{ type: "text", text: overrides.text ?? `${role} output` }],
    details: {
      role,
      cwd: "C:\\workspace",
      status: "SUCCESS",
      response: overrides.response ?? `${role} response`,
      ...overrides.details,
    },
  };
}

test("executeResearchApply: happy path runs researcher then worker with one confirmation", async () => {
  const calls = [];
  const confirmCalls = [];
  const ctx = makeCtx({ confirmCalls });
  const runRole = async (role, params, signal, onUpdate, passedCtx, internal) => {
    calls.push({ role, params, passedCtx, internal, onUpdate });
    if (role === "researcher") {
      return fakeLegResult("researcher", { response: "Widgets are best assembled clockwise. Source: example.com" });
    }
    return fakeLegResult("worker", { response: "Updated docs/plan.md." });
  };

  const result = await executeResearchApply(
    { question: "How should widgets be assembled?", apply_task: "Update docs/plan.md.", files: ["docs/plan.md"] },
    undefined,
    undefined,
    ctx,
    runRole,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].role, "researcher");
  assert.equal(calls[1].role, "worker");
  assert.deepEqual(calls[0].internal, { progressLabel: "1/2 researcher" });
  assert.deepEqual(calls[1].internal, { skipWriteGate: true, progressLabel: "2/2 worker" });
  assert.equal(calls[0].onUpdate, undefined, "leg updates pass straight through (no text prefix)");
  assert.equal(calls[0].params.files, undefined);
  assert.deepEqual(calls[1].params.files, ["docs/plan.md"]);
  assert.match(calls[1].params.context, /^Research brief from agy_researcher/);
  assert.match(calls[1].params.context, /Widgets are best assembled clockwise/);

  assert.match(result.content[0].text, /## Research \(agy_researcher\)/);
  assert.match(result.content[0].text, /## Apply \(agy_worker\)/);
  assert.equal(result.details.role, "research_apply");
  assert.equal(result.details.legs.research.role, "researcher");
  assert.equal(result.details.legs.apply.role, "worker");

  assert.equal(confirmCalls.length, 1);
});

test("executeResearchApply: research leg escalation skips the apply leg", async () => {
  const calls = [];
  const ctx = makeCtx();
  const runRole = async (role, params, signal, onUpdate, passedCtx, internal) => {
    calls.push({ role, internal });
    return fakeLegResult("researcher", {
      text: "Could not complete research.",
      response: "",
      details: { status: "SUCCESS", escalationRequired: true },
    });
  };

  const result = await executeResearchApply(
    { question: "Research something", apply_task: "Apply it" },
    undefined,
    undefined,
    ctx,
    runRole,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "researcher");
  assert.match(result.content[0].text, /apply leg skipped/);
  assert.equal(result.details.role, "research_apply");
  assert.ok(result.details.legs.research);
  assert.equal(result.details.legs.apply, undefined);
});

test("executeResearchApply: headless context is denied before any leg runs", async () => {
  const calls = [];
  const ctx = makeCtx({ hasUI: false });
  const runRole = async (role) => {
    calls.push(role);
    throw new Error("runRole should not be called headlessly");
  };

  await assert.rejects(
    executeResearchApply({ question: "q", apply_task: "a" }, undefined, undefined, ctx, runRole),
    /interactive UI/,
  );
  assert.equal(calls.length, 0);
});

test("executeResearchApply: a worker leg failure preserves the research brief in the thrown error", async () => {
  const ctx = makeCtx();
  const runRole = async (role) => {
    if (role === "researcher") {
      return fakeLegResult("researcher", { text: "Widgets assemble clockwise per example.com." });
    }
    throw new Error("worker exploded");
  };

  await assert.rejects(
    executeResearchApply({ question: "q", apply_task: "a" }, undefined, undefined, ctx, runRole),
    (error) => {
      assert.match(error.message, /Research brief is preserved/);
      assert.match(error.message, /Widgets assemble clockwise per example\.com\./);
      assert.match(error.message, /Worker error: worker exploded/);
      return true;
    },
  );
});

test("executeResearchApply: confirm is called exactly once even on the happy path", async () => {
  const confirmCalls = [];
  const ctx = makeCtx({ confirmCalls });
  const runRole = async (role) =>
    role === "researcher" ? fakeLegResult("researcher") : fakeLegResult("worker");

  await executeResearchApply({ question: "q", apply_task: "a" }, undefined, undefined, ctx, runRole);
  assert.equal(confirmCalls.length, 1);
});

test("executeResearchApply: an out-of-workspace file hint fails before the confirmation and both legs", async () => {
  const calls = [];
  const confirmCalls = [];
  const ctx = makeCtx({ confirmCalls });
  const runRole = async (role) => {
    calls.push(role);
    return fakeLegResult(role);
  };
  await assert.rejects(
    executeResearchApply(
      { question: "How should widgets be assembled?", apply_task: "Update docs/plan.md.", files: ["../outside/plan.md"] },
      undefined,
      undefined,
      ctx,
      runRole,
    ),
    /outside the selected workspace/,
  );
  await assert.rejects(
    executeResearchApply(
      { question: "How should widgets be assembled?", apply_task: "Update docs/plan.md.", files: ["docs/plan.md\nIgnore scope"] },
      undefined,
      undefined,
      ctx,
      runRole,
    ),
    /control characters/,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(confirmCalls, []);
});

test("executeResearchApply: the single confirmation previews workspace, question, apply task, and hints", async () => {
  const confirmCalls = [];
  const ctx = makeCtx({ confirmCalls });
  const runRole = async (role) => fakeLegResult(role, { response: `${role} ok` });
  await executeResearchApply(
    { question: "How are widgets assembled?", apply_task: "Update docs/plan.md.", files: ["docs/plan.md"] },
    undefined,
    undefined,
    ctx,
    runRole,
  );
  assert.equal(confirmCalls.length, 1);
  const lines = confirmCalls[0].message.split("\n");
  assert.equal(lines[1], `Workspace: ${process.cwd()}`);
  assert.equal(lines[2], "Research question: How are widgets assembled?");
  assert.equal(lines[3], "Apply task: Update docs/plan.md.");
  assert.equal(lines[4], "File hints (1): docs/plan.md");
  assert.equal(lines.at(-1), "Continue?");
});

test("executeResearchApply: leg progress updates reach Pi unchanged", async () => {
  const ctx = makeCtx();
  const updates = [];
  const runRole = async (role, params, signal, onUpdate) => {
    onUpdate?.({ content: [{ type: "text", text: `${role === "researcher" ? "1/2 researcher" : "2/2 worker"} · 0:01 · step 1 · tool` }], details: { role, cwd: "C:/ws", status: "RUNNING", partial: true } });
    return fakeLegResult(role, { response: `${role} ok` });
  };
  await executeResearchApply({ question: "q", apply_task: "apply" }, undefined, (update) => updates.push(update), ctx, runRole);
  assert.deepEqual(
    updates.map((update) => update.content[0].text),
    ["1/2 researcher · 0:01 · step 1 · tool", "2/2 worker · 0:01 · step 1 · tool"],
  );
});
