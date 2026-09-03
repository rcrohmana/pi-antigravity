import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { authorizeWriteRole, isWithinPath, validateCwd, validateTask } from "../src/policy.ts";

test("write roles require UI confirmation", async () => {
  let confirmations = 0;
  let confirmationMessage = "";
  const allowed = await authorizeWriteRole("worker", {
    hasUI: true,
    confirm: async (_title, message) => {
      confirmationMessage = message;
      confirmations += 1;
      return true;
    },
  });
  assert.deepEqual(allowed, { allowed: true });
  assert.equal(confirmations, 1);
  assert.match(confirmationMessage, /workspace file-edit capability/);
  assert.match(confirmationMessage, /sandboxed command execution/);
  assert.match(confirmationMessage, /Agy's own permission policy/);

  const rejected = await authorizeWriteRole("delegate", { hasUI: false });
  assert.equal(rejected.allowed, false);
  assert.match(rejected.reason, /denied/);

  assert.deepEqual(await authorizeWriteRole("scout", { hasUI: false }), { allowed: true });
  assert.deepEqual(await authorizeWriteRole("researcher", { hasUI: false }), { allowed: true });
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
