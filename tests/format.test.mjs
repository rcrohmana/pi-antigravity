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
