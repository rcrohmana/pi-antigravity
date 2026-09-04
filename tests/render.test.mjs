// render.ts wraps src/format.ts in pi-tui Text; these tests use a
// pass-through theme and read the Text's plain content.
import assert from "node:assert/strict";
import test from "node:test";

import { renderAgyCall, renderAgyResult } from "../src/render.ts";

const styles = [];
const theme = {
  fg: (style, text) => {
    styles.push(style);
    return text;
  },
  bold: (text) => text,
};

test("the call line names the role and flags write capability", () => {
  styles.length = 0;
  assert.equal(renderAgyCall({ role: "worker", task: "edit   the\nplan", cwd: "C:/ws" }, theme).text, "agy worker (writes) C:/ws edit the plan");
  assert.ok(styles.includes("warning"), "write capability is rendered as a warning");
  styles.length = 0;
  assert.equal(renderAgyCall({ role: "scout", task: "look", cwd: "C:/ws" }, theme).text, "agy scout (read-only) C:/ws look");
  assert.ok(!styles.includes("warning"));
  assert.equal(renderAgyCall({ role: "research_apply", task: "q → apply", cwd: "C:/ws" }, theme).text, "agy research_apply (research → writes) C:/ws q → apply");
  assert.equal(renderAgyCall({ role: "doctor", task: "doctor" }, theme).text, "agy doctor (read-only) . doctor");
  assert.equal(renderAgyCall({ task: "legacy" }, theme).text, "agy . legacy");
});

test("the result summary carries duration, turns, tokens, retry marker, and conversation id", () => {
  const result = {
    content: [{ type: "text", text: "hello world\n" }],
    details: { role: "worker", cwd: "C:/ws", status: "SUCCESS", durationMs: 102_000, numTurns: 5, usage: { total_tokens: 12_345 }, conversationId: "a0ecb8ba-6e92-47d2-aaa0-5a63c248ab64", retry: { attempted: true } },
  };
  styles.length = 0;
  assert.equal(renderAgyResult(result, { expanded: false, isPartial: false }, theme).text, "✓ worker · 1m 42s · 5 turns · 12.3k tokens · ↻ retried once · conv a0ecb8ba: hello world");
  assert.deepEqual(styles, ["success"]);
  assert.equal(renderAgyResult(result, { expanded: true, isPartial: false }, theme).text, "✓ worker · 1m 42s · 5 turns · 12.3k tokens · ↻ retried once · conv a0ecb8ba\nhello world");
});

test("escalations and errors keep their markers and show a retry when one happened", () => {
  styles.length = 0;
  const escalated = { content: [{ type: "text", text: "" }], details: { role: "scout", cwd: "C:/ws", status: "SUCCESS", escalationRequired: true, durationMs: 3_000 } };
  assert.equal(renderAgyResult(escalated, { expanded: false, isPartial: false }, theme).text, "⚠ scout · 3s: ");
  assert.deepEqual(styles, ["warning"]);

  const failed = { content: [], details: { role: "worker", cwd: "C:/ws", status: "CANCELED", error: "ESCALATION REQUIRED: Agy ended the run with status CANCELED", retry: { attempted: true } } };
  assert.equal(renderAgyResult(failed, { expanded: false, isPartial: false }, theme).text, "⚠ ESCALATION REQUIRED: Agy ended the run with status CANCELED · ↻ retried once");
  const plain = { content: [], details: { role: "worker", cwd: "C:/ws", status: "ERROR", error: "Agy delegation exceeded 300000ms" } };
  assert.equal(renderAgyResult(plain, { expanded: false, isPartial: false }, theme).text, "✗ Agy delegation exceeded 300000ms");
});

test("partial results show the latest progress text", () => {
  const partial = { content: [{ type: "text", text: "worker · 1:42 · step 7 · run_command git status" }], details: { role: "worker", cwd: "C:/ws", status: "RUNNING", partial: true } };
  assert.equal(renderAgyResult(partial, { expanded: false, isPartial: true }, theme).text, "worker · 1:42 · step 7 · run_command git status");
});
