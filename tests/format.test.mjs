import assert from "node:assert/strict";
import test from "node:test";

import {
  PROGRESS_DETAIL_CHARS,
  describeRoleCapability,
  formatClock,
  formatDuration,
  formatProgress,
  formatResultSummary,
  formatTokens,
  shortConversationId,
} from "../src/format.ts";

test("formatDuration humanises milliseconds", () => {
  assert.equal(formatDuration(undefined), undefined);
  assert.equal(formatDuration(-5), undefined);
  assert.equal(formatDuration(Number.NaN), undefined);
  assert.equal(formatDuration(842), "842ms");
  assert.equal(formatDuration(12_400), "12s");
  assert.equal(formatDuration(102_000), "1m 42s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_720_000), "1h 02m");
});

test("formatClock renders a running m:ss clock", () => {
  assert.equal(formatClock(undefined), undefined);
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(7_900), "0:07");
  assert.equal(formatClock(102_000), "1:42");
  assert.equal(formatClock(3_723_000), "1:02:03");
});

test("formatTokens prefers total_tokens and falls back to input plus output", () => {
  assert.equal(formatTokens(undefined), undefined);
  assert.equal(formatTokens({}), undefined);
  assert.equal(formatTokens({ total_tokens: 532 }), "532 tokens");
  assert.equal(formatTokens({ total_tokens: 12_345 }), "12.3k tokens");
  assert.equal(formatTokens({ total_tokens: 2_000 }), "2k tokens");
  assert.equal(formatTokens({ total_tokens: 1_250_000 }), "1.25M tokens");
  assert.equal(formatTokens({ input_tokens: 400, output_tokens: 100 }), "500 tokens");
  assert.equal(formatTokens({ input_tokens: 400 }), "400 tokens");
  assert.equal(formatTokens({ total_tokens: -1 }), undefined);
});

test("shortConversationId keeps a scannable prefix", () => {
  assert.equal(shortConversationId(undefined), undefined);
  assert.equal(shortConversationId("conv-123"), "conv-123");
  assert.equal(shortConversationId("a0ecb8ba-6e92-47d2-aaa0-5a63c248ab64"), "a0ecb8ba");
});

test("describeRoleCapability flags write-capable roles and the composite tool", () => {
  assert.equal(describeRoleCapability("scout"), "read-only");
  assert.equal(describeRoleCapability("researcher"), "read-only");
  assert.equal(describeRoleCapability("worker"), "writes");
  assert.equal(describeRoleCapability("delegate"), "writes");
  assert.equal(describeRoleCapability("research_apply"), "research → writes");
  assert.equal(describeRoleCapability("doctor"), "read-only");
  assert.equal(describeRoleCapability("unknown"), undefined);
  assert.equal(describeRoleCapability(undefined), undefined);
  // A prototype key must not be mistaken for a role.
  assert.equal(describeRoleCapability("toString"), undefined);
});

test("formatProgress shows role, clock, step, and tool target or text tail", () => {
  assert.equal(formatProgress({ role: "worker" }), "worker · working");
  assert.equal(formatProgress({ role: "worker", elapsedMs: 102_000, stepIndex: 7, stepType: "tool", toolName: "run_command", toolTarget: "git   status" }), "worker · 1:42 · step 7 · run_command git status");
  assert.equal(formatProgress({ role: "worker", elapsedMs: 500, stepType: "tool", toolName: "list_dir" }), "worker · 0:00 · list_dir");
  assert.equal(formatProgress({ role: "researcher", elapsedMs: 12_000, stepIndex: 2, stepType: "agent_response", textDelta: "  Vsh from\n gamma ray  " }), "researcher · 0:12 · step 2 · agent_response: Vsh from gamma ray");
  assert.equal(formatProgress({ role: "scout", stepType: "thinking" }), "scout · thinking");
  const longTarget = "C:/ws/" + "x".repeat(200);
  const withTool = formatProgress({ role: "worker", toolName: "view_file", toolTarget: longTarget });
  assert.equal(withTool, `worker · view_file ${longTarget.slice(0, PROGRESS_DETAIL_CHARS)}`);
  const longText = "a".repeat(200) + " end";
  const withText = formatProgress({ role: "worker", textDelta: longText });
  assert.ok(withText.endsWith(" end"));
  assert.equal(withText.length, "worker · text: ".length + PROGRESS_DETAIL_CHARS);
});

test("formatResultSummary shows duration, turns, tokens, retry marker, and short conversation id", () => {
  assert.equal(formatResultSummary(undefined), "✓ agy");
  assert.equal(formatResultSummary({ role: "scout", status: "SUCCESS", cwd: "C:/ws" }), "✓ scout");
  assert.equal(
    formatResultSummary({
      role: "worker",
      status: "SUCCESS",
      cwd: "C:/ws",
      durationMs: 102_000,
      numTurns: 5,
      usage: { total_tokens: 12_345 },
      retry: { attempted: true, firstAttemptStatus: "CANCELED", firstAttemptDeniedTools: [], firstAttemptDeniedActions: [] },
      conversationId: "a0ecb8ba-6e92-47d2-aaa0-5a63c248ab64",
    }),
    "✓ worker · 1m 42s · 5 turns · 12.3k tokens · ↻ retried once · conv a0ecb8ba",
  );
  assert.equal(formatResultSummary({ role: "worker", status: "SUCCESS", cwd: "C:/ws", durationMs: 250, numTurns: 1, usage: { total_tokens: 14 }, conversationId: "conv-123" }), "✓ worker · 250ms · 1 turn · 14 tokens · conv conv-123");
  assert.equal(formatResultSummary({ role: "scout", status: "SUCCESS", cwd: "C:/ws", escalationRequired: true, durationMs: 3_000 }), "⚠ scout · 3s");
});

test("formatCompositeResultSummary lists both legs with total duration and tokens", async () => {
  const { formatCompositeResultSummary } = await import("../src/format.ts");
  const legs = {
    research: { role: "researcher", cwd: "C:/ws", status: "SUCCESS", durationMs: 130_000, usage: { total_tokens: 10_000 } },
    apply: { role: "worker", cwd: "C:/ws", status: "SUCCESS", durationMs: 48_000, usage: { total_tokens: 5_200 }, retry: { attempted: true } },
  };
  assert.equal(
    formatCompositeResultSummary({ role: "research_apply", status: "SUCCESS", cwd: "C:/ws", legs, conversationId: "a0ecb8ba-6e92-47d2-aaa0-5a63c248ab64" }),
    "✓ research_apply · 2m 58s · research ✓ 2m 10s · apply ✓ 48s · 15.2k tokens · ↻ retried once · conv a0ecb8ba",
  );
  assert.equal(
    formatCompositeResultSummary({ role: "research_apply", status: "SUCCESS", cwd: "C:/ws", escalationRequired: true, legs: { research: { role: "researcher", cwd: "C:/ws", status: "SUCCESS", escalationRequired: true, durationMs: 9_000 } } }),
    "⚠ research_apply · 9s · research ⚠ 9s",
  );
  assert.equal(formatCompositeResultSummary({ role: "research_apply", status: "SUCCESS", cwd: "C:/ws", legs: { research: { role: "researcher", cwd: "C:/ws", status: "CANCELED" } } }), "✓ research_apply · research ✗");
  assert.equal(formatCompositeResultSummary({ role: "worker", status: "SUCCESS", cwd: "C:/ws", durationMs: 250 }), "✓ worker · 250ms");
});

test("formatDenialActions gives copy-ready rules, deduplicated, then the next step", async () => {
  const { formatDenialActions } = await import("../src/format.ts");
  assert.equal(
    formatDenialActions({ suggestedRules: ["command(git status)", "command(git status)", " ", "read_file(C:/ws)"], conversationId: "conv-1", platform: "win32" }),
    'Add to permissions.allow in %USERPROFILE%\\.gemini\\antigravity-cli\\settings.json:\n  "command(git status)"\n  "read_file(C:/ws)"\nNext: run /agy_doctor to verify the rules, then continue this run with conversation_id "conv-1".',
  );
  assert.equal(
    formatDenialActions({ suggestedRules: [], platform: "linux" }),
    "Add a matching allow rule to permissions.allow in ~/.gemini/antigravity-cli/settings.json (see the denial details below).\nNext: run /agy_doctor to verify the rules.",
  );
});

test("formatTerminationMessage explains timeout and cancel with a resume hint", async () => {
  const { formatTerminationMessage } = await import("../src/format.ts");
  assert.equal(
    formatTerminationMessage({ reason: "timeout", elapsedMs: 300_400, timeoutMs: 300_000, conversationId: "conv-1" }),
    'Agy delegation exceeded 300000ms (5m 00s); the Agy process was terminated. Work so far is kept in Agy conversation conv-1; continue it with conversation_id "conv-1".',
  );
  assert.equal(
    formatTerminationMessage({ reason: "aborted", elapsedMs: 62_000 }),
    "Agy delegation was canceled after 1m 02s; the Agy process was terminated. No Agy conversation id was received before it stopped, so the run cannot be resumed; start it again.",
  );
  assert.match(formatTerminationMessage({ reason: "aborted" }), /^Agy delegation was canceled; the Agy process was terminated\./);
});

test("formatReadyNotice states the covering rules and command count", async () => {
  const { formatReadyNotice } = await import("../src/format.ts");
  assert.equal(
    formatReadyNotice({ cwd: "C:/ws", readRule: "read_file(C:/)", writeRule: "write_file(C:/)", readOnlyRole: false, commandCount: 3 }),
    "✓ Agy ready for C:/ws: read_file(C:/) (read) and write_file(C:/) (write) cover this workspace; 3 commands allowed",
  );
  assert.equal(formatReadyNotice({ cwd: "C:/ws", readRule: "read_file(C:/)", writeRule: "write_file(C:/)", readOnlyRole: true, commandCount: 3 }), "✓ Agy ready for C:/ws: read_file(C:/) (read) cover this workspace");
  assert.equal(
    formatReadyNotice({ cwd: "C:/ws", readRule: "read_file(C:/)", readOnlyRole: false, commandCount: 0 }),
    "✓ Agy ready for C:/ws: read_file(C:/) (read) cover this workspace; no write_file rule (writes will be auto-denied); no commands allowed",
  );
  assert.equal(formatReadyNotice({ cwd: "C:/ws", readRule: "read_file(C:/)", writeRule: "write_file(C:/)", readOnlyRole: false }), "✓ Agy ready for C:/ws: read_file(C:/) (read) and write_file(C:/) (write) cover this workspace");
});

test("relativizeTarget shows in-workspace targets relative to cwd and leaves others absolute", async () => {
  const { relativizeTarget } = await import("../src/format.ts");
  assert.equal(relativizeTarget("C:\\Users\\me\\ws\\script\\vsh.py", "C:\\Users\\me\\ws", "win32"), "script/vsh.py");
  assert.equal(relativizeTarget("c:/users/ME/ws/a.ts", "C:\\Users\\me\\ws\\", "win32"), "a.ts");
  assert.equal(relativizeTarget("C:\\Users\\me\\ws", "C:\\Users\\me\\ws", "win32"), ".");
  assert.equal(relativizeTarget("C:\\Users\\me\\ws-other\\a.ts", "C:\\Users\\me\\ws", "win32"), "C:\\Users\\me\\ws-other\\a.ts");
  assert.equal(relativizeTarget("D:\\elsewhere\\a.ts", "C:\\Users\\me\\ws", "win32"), "D:\\elsewhere\\a.ts");
  assert.equal(relativizeTarget("/home/me/ws/src/a.ts", "/home/me/ws", "linux"), "src/a.ts");
  assert.equal(relativizeTarget("/home/me/WS/src/a.ts", "/home/me/ws", "linux"), "/home/me/WS/src/a.ts");
  assert.equal(relativizeTarget("git status", "/home/me/ws", "linux"), "git status");
  assert.equal(relativizeTarget(undefined, "/home/me/ws"), undefined);
  assert.equal(relativizeTarget("a.ts", undefined), "a.ts");
});
