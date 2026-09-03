import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  authorizeWriteRole,
  buildWriteConfirmationMessage,
  isWithinPath,
  MAX_CONFIRMATION_TASK_CHARS,
  validateCwd,
  validateTask,
} from "../src/policy.ts";

test("write confirmation previews reviewed inputs and actual capabilities", async () => {
  const request = {
    cwd: "C:\\workspace\\canonical-child",
    task: "Update the selected file only.",
    context: "The API must retain the existing response shape.",
    files: ["C:\\workspace\\src\\target.ts", "C:\\workspace\\tests\\target.test.ts"],
  };
  let confirmations = 0;
  let confirmationTitle = "";
  let confirmationMessage = "";
  const allowed = await authorizeWriteRole("worker", request, {
    hasUI: true,
    confirm: async (title, message) => {
      confirmationTitle = title;
      confirmationMessage = message;
      confirmations += 1;
      return true;
    },
  });
  assert.deepEqual(allowed, { allowed: true });
  assert.equal(confirmations, 1);
  assert.equal(confirmationTitle, "Allow Agy worker writes?");
  assert.match(confirmationMessage, /Workspace \(canonical\): C:\\workspace\\canonical-child/);
  assert.match(confirmationMessage, /not a filesystem write sandbox/);
  assert.match(confirmationMessage, /Agy write_file\(\.\.\.\) permission rules/);
  assert.match(confirmationMessage, /Task \(30 characters\):\nUpdate the selected file only\./);
  assert.match(confirmationMessage, /Explicit context \(48 characters\):/);
  assert.match(confirmationMessage, /File hints \(2\):/);
  assert.match(confirmationMessage, /Create and replace file content/);
  assert.match(confirmationMessage, /command\(\) allow rules/);
  assert.match(confirmationMessage, /does not use --sandbox/);
  assert.doesNotMatch(confirmationMessage, /sandboxed command execution/);

  const longMessage = buildWriteConfirmationMessage("delegate", {
    cwd: "C:\\workspace",
    task: `start-${"x".repeat(MAX_CONFIRMATION_TASK_CHARS)}-end`,
  });
  assert.match(longMessage, /preview truncated/);
  assert.match(longMessage, /start-/);
  assert.match(longMessage, /-end/);
  const escapedControlMessage = buildWriteConfirmationMessage("worker", { cwd: "C:\\workspace", task: "safe\u001b[2J" });
  assert.match(escapedControlMessage, /safe\\u001b\[2J/);

  const rejected = await authorizeWriteRole("delegate", request, { hasUI: false });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reason, /denied/);

  assert.deepEqual(await authorizeWriteRole("scout", request, { hasUI: false }), { allowed: true });
  assert.deepEqual(await authorizeWriteRole("researcher", request, { hasUI: false }), { allowed: true });
});

test("cwd is canonicalized and restricted to the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agy-policy-"));
  const child = join(root, "child");
  await mkdir(child);
  try {
    assert.equal(await validateCwd(child, root), child);
    await assert.rejects(validateCwd(join(root, ".."), root), /outside the allowed workspace/);
    assert.equal(isWithinPath(root, child), true);
    assert.equal(isWithinPath(child, root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task validation rejects empty, NUL, and oversized input", () => {
  assert.throws(() => validateTask(""), /non-empty/);
  assert.throws(() => validateTask("bad\0task"), /NUL/);
  assert.throws(() => validateTask("x".repeat(20_001)), /exceeds/);
});
