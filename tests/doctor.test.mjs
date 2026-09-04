import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFIED_AGY_CLI_VERSIONS,
  REQUIRED_AGY_ROLES,
  normalizeRuleTarget,
  isPathCoveredByRule,
  extractFileRules,
  isWellFormedWin32FileRule,
  analyzePermissions,
  preflightCwdCoverage,
  runAgyDoctor,
} from "../src/doctor.ts";

// ---- normalizeRuleTarget -------------------------------------------------

test("normalizeRuleTarget: win32 is case-insensitive", () => {
  assert.equal(normalizeRuleTarget("C:\\Users\\Tester", "win32"), "c:/users/tester");
  assert.equal(normalizeRuleTarget("c:/users/tester", "win32"), "c:/users/tester");
});

test("normalizeRuleTarget: converts backslashes to forward slashes", () => {
  assert.equal(normalizeRuleTarget("C:\\Users\\Tester\\Project", "win32"), "c:/users/tester/project");
});

test("normalizeRuleTarget: strips a trailing slash but keeps a bare drive root", () => {
  assert.equal(normalizeRuleTarget("C:\\Users\\Tester\\", "win32"), "c:/users/tester");
  assert.equal(normalizeRuleTarget("C:\\", "win32"), "c:/");
  assert.equal(normalizeRuleTarget("C:/", "win32"), "c:/");
});

test("normalizeRuleTarget: collapses duplicate slashes", () => {
  assert.equal(normalizeRuleTarget("C://Users//Tester", "win32"), "c:/users/tester");
});

test("normalizeRuleTarget: does not lowercase on posix", () => {
  assert.equal(normalizeRuleTarget("/Home/Tester/", "linux"), "/Home/Tester");
});

test("normalizeRuleTarget: trims surrounding whitespace", () => {
  assert.equal(normalizeRuleTarget("  C:/Users/Tester  ", "win32"), "c:/users/tester");
});

// ---- isPathCoveredByRule --------------------------------------------------

test("isPathCoveredByRule: exact equality covers", () => {
  assert.equal(isPathCoveredByRule("C:/Users/tester/project", "C:\\Users\\tester\\project", "win32"), true);
});

test("isPathCoveredByRule: nested path under a rule with a trailing slash is covered", () => {
  assert.equal(isPathCoveredByRule("C:/Users/tester/project/", "C:\\Users\\tester\\project\\sub\\file.txt", "win32"), true);
});

test("isPathCoveredByRule: drive-less rule does not cover a drive-qualified path", () => {
  assert.equal(isPathCoveredByRule("Users/tester/project", "C:/Users/tester/project/file.txt", "win32"), false);
});

test("isPathCoveredByRule: leading-slash rule does not cover a drive-qualified path", () => {
  assert.equal(isPathCoveredByRule("/Users/tester/project", "C:/Users/tester/project/file.txt", "win32"), false);
});

test("isPathCoveredByRule: sibling directory with a shared prefix is not covered", () => {
  assert.equal(isPathCoveredByRule("C:/Users/tester/project", "C:/Users/tester/project2/file.txt", "win32"), false);
});

test("isPathCoveredByRule: empty rule target never covers anything", () => {
  assert.equal(isPathCoveredByRule("   ", "C:/Users/tester/project", "win32"), false);
});

test("isPathCoveredByRule: posix comparison is case-sensitive", () => {
  assert.equal(isPathCoveredByRule("/home/tester", "/home/Tester/file", "linux"), false);
  assert.equal(isPathCoveredByRule("/home/tester", "/home/tester/file", "linux"), true);
});

// ---- extractFileRules -----------------------------------------------------

test("extractFileRules: separates read_file and write_file targets", () => {
  const json = {
    permissions: {
      allow: [
        "read_file(C:/Users/tester/project)",
        "write_file(C:/Users/tester/project)",
        "command(git status)",
        "read_url(*)",
      ],
    },
  };
  assert.deepEqual(extractFileRules(json, "read_file"), ["C:/Users/tester/project"]);
  assert.deepEqual(extractFileRules(json, "write_file"), ["C:/Users/tester/project"]);
});

test("extractFileRules: trims targets and de-duplicates while preserving order", () => {
  const json = { permissions: { allow: ["read_file( C:/a )", "read_file(C:/b)", "read_file(C:/a)"] } };
  assert.deepEqual(extractFileRules(json, "read_file"), ["C:/a", "C:/b"]);
});

for (const [label, json] of [
  ["null", null],
  ["array", ["read_file(C:/a)"]],
  ["missing permissions", {}],
  ["permissions not object", { permissions: "nope" }],
  ["allow not array", { permissions: { allow: "read_file(C:/a)" } }],
  ["non-string entries", { permissions: { allow: [42, null, { read_file: "C:/a" }] } }],
  ["undefined", undefined],
]) {
  test(`extractFileRules: tolerates malformed shape (${label})`, () => {
    assert.deepEqual(extractFileRules(json, "read_file"), []);
  });
}

// ---- isWellFormedWin32FileRule --------------------------------------------

test("isWellFormedWin32FileRule: accepts drive-letter forward-slash form", () => {
  assert.equal(isWellFormedWin32FileRule("C:/Users/tester/project"), true);
});

test("isWellFormedWin32FileRule: accepts drive-letter backslash form (normalized before the check)", () => {
  assert.equal(isWellFormedWin32FileRule("C:\\Users\\tester\\project"), true);
});

test("isWellFormedWin32FileRule: rejects drive-less and leading-slash forms", () => {
  assert.equal(isWellFormedWin32FileRule("Users/tester/project"), false);
  assert.equal(isWellFormedWin32FileRule("/Users/tester/project"), false);
  assert.equal(isWellFormedWin32FileRule(""), false);
});

// ---- analyzePermissions -----------------------------------------------------

const REALISTIC_SETTINGS = {
  permissions: {
    allow: [
      "read_file(C:/Users/tester/project)",
      "read_file(Users/tester/other)",
      "write_file(C:/Users/tester/project)",
      "command(git status)",
      "command(npm test)",
    ],
    deny: [
      "read_file(C:/Users/tester/.ssh)",
      "read_file(C:/Users/tester/.gnupg)",
      "read_file(C:/Users/tester/.aws)",
      "read_file(C:/Users/tester/.azure)",
      "read_file(C:/Users/tester/.config/gcloud)",
      "read_file(C:/Users/tester/.gemini)",
      "read_file(C:/Users/tester/.npmrc)",
      "read_file(C:/Users/tester/.git-credentials)",
      "read_file(C:/Users/tester/.env)",
      "read_file(C:/Users/tester/.pi/agent)",
      // .kube and .docker intentionally left undenied
    ],
  },
};

test("analyzePermissions: finds covering read/write rules and lists command rules", () => {
  const analysis = analyzePermissions(REALISTIC_SETTINGS, "C:\\Users\\tester\\project", "win32", "C:\\Users\\tester");
  assert.equal(analysis.readCoveringRule, "C:/Users/tester/project");
  assert.equal(analysis.writeCoveringRule, "C:/Users/tester/project");
  assert.deepEqual(analysis.commandRules, ["git status", "npm test"]);
});

test("analyzePermissions: flags only the malformed win32 file rule target", () => {
  const analysis = analyzePermissions(REALISTIC_SETTINGS, "C:\\Users\\tester\\project", "win32", "C:\\Users\\tester");
  assert.deepEqual(analysis.malformedFileRules, ["Users/tester/other"]);
});

test("analyzePermissions: malformedFileRules is empty off win32 regardless of rule shape", () => {
  const analysis = analyzePermissions(REALISTIC_SETTINGS, "C:\\Users\\tester\\project", "linux", "C:\\Users\\tester");
  assert.deepEqual(analysis.malformedFileRules, []);
});

test("analyzePermissions: reports missing sensitive-path denies relative to homeDir", () => {
  const analysis = analyzePermissions(REALISTIC_SETTINGS, "C:\\Users\\tester\\project", "win32", "C:\\Users\\tester");
  assert.deepEqual(analysis.missingSensitiveDenies, ["C:/Users/tester/.kube", "C:/Users/tester/.docker"]);
});

test("analyzePermissions: no cwd coverage and no sensitive check without homeDir", () => {
  const analysis = analyzePermissions(REALISTIC_SETTINGS, "C:\\Users\\other\\project", "win32");
  assert.equal(analysis.readCoveringRule, undefined);
  assert.equal(analysis.writeCoveringRule, undefined);
  assert.deepEqual(analysis.missingSensitiveDenies, []);
});

test("analyzePermissions: tolerates malformed settings shape", () => {
  const analysis = analyzePermissions(null, "C:\\Users\\tester\\project", "win32", "C:\\Users\\tester");
  assert.deepEqual(analysis.readRules, []);
  assert.deepEqual(analysis.writeRules, []);
  assert.deepEqual(analysis.commandRules, []);
  assert.deepEqual(analysis.denyRules, []);
  assert.equal(analysis.readCoveringRule, undefined);
});

// ---- preflightCwdCoverage ---------------------------------------------------

test("preflightCwdCoverage: reads settings and reports covering rules", async () => {
  const result = await preflightCwdCoverage({
    cwd: "C:\\Users\\tester\\project",
    env: { USERPROFILE: "C:\\Users\\tester" },
    platform: "win32",
    readFile: async () => JSON.stringify(REALISTIC_SETTINGS),
  });
  assert.equal(result.source, "settings");
  assert.equal(result.readCoveringRule, "C:/Users/tester/project");
  assert.equal(result.writeCoveringRule, "C:/Users/tester/project");
});

test("preflightCwdCoverage: ENOENT is unavailable with a names-only reason", async () => {
  const error = new Error("no such file");
  error.code = "ENOENT";
  const result = await preflightCwdCoverage({
    cwd: "C:\\Users\\tester\\project",
    env: { USERPROFILE: "C:\\Users\\tester" },
    platform: "win32",
    readFile: async () => {
      throw error;
    },
  });
  assert.equal(result.source, "unavailable");
  assert.equal(result.reason, "ENOENT");
});

test("preflightCwdCoverage: missing base env variable is unavailable without a spawn", async () => {
  const result = await preflightCwdCoverage({ cwd: "C:\\Users\\tester\\project", env: {}, platform: "win32" });
  assert.equal(result.source, "unavailable");
  assert.equal(result.reason, "USERPROFILE not set");
});

// ---- runAgyDoctor -----------------------------------------------------------

const REQUIRED_WIN32_NAMES = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "SystemRoot",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

function syntheticWin32Env(overrides = {}) {
  return {
    PATH: "C:\\SyntheticPath",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\tester",
    LOGONSERVER: "\\\\SYNTHETIC",
    SYSTEMDRIVE: "C:",
    SystemRoot: "C:\\SyntheticWindows",
    TEMP: "C:\\SyntheticTemp",
    USERDOMAIN: "SYNTHETIC-DOMAIN",
    USERNAME: "tester",
    USERPROFILE: "C:\\Users\\tester",
    WINDIR: "C:\\SyntheticWindows",
    AGY_CLI_PATH: "C:\\Tools\\agy\\agy.exe",
    ...overrides,
  };
}

const WORKING_EXEC = async (_executable, args) => {
  if (args[0] === "--version") return { code: 0, stdout: "1.1.26\n", stderr: "" };
  if (args[0] === "agent") return { code: 0, stdout: "delegate\nresearcher\nscout\nworker\n", stderr: "" };
  return { code: 1, stdout: "", stderr: "unexpected args" };
};

const WORKING_READ_FILE = async () => JSON.stringify(REALISTIC_SETTINGS);

// Unlike REALISTIC_SETTINGS above, this fixture has no malformed file-rule
// target and denies every documented sensitive path, so a doctor run against
// it should come back fully clean.
const ALL_OK_SETTINGS = {
  permissions: {
    allow: [
      "read_file(C:/Users/tester/project)",
      "write_file(C:/Users/tester/project)",
      "command(git status)",
      "command(npm test)",
    ],
    deny: [
      "read_file(C:/Users/tester/.ssh)",
      "read_file(C:/Users/tester/.gnupg)",
      "read_file(C:/Users/tester/.aws)",
      "read_file(C:/Users/tester/.azure)",
      "read_file(C:/Users/tester/.config/gcloud)",
      "read_file(C:/Users/tester/.gemini)",
      "read_file(C:/Users/tester/.npmrc)",
      "read_file(C:/Users/tester/.git-credentials)",
      "read_file(C:/Users/tester/.kube)",
      "read_file(C:/Users/tester/.docker)",
      "read_file(C:/Users/tester/.env)",
      "read_file(C:/Users/tester/.pi/agent)",
    ],
  },
};
const ALL_OK_READ_FILE = async () => JSON.stringify(ALL_OK_SETTINGS);

test("runAgyDoctor: all-ok run reports ok with every check passing", async () => {
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env: syntheticWin32Env(),
    platform: "win32",
    exists: () => true,
    exec: WORKING_EXEC,
    readFile: ALL_OK_READ_FILE,
  });
  assert.equal(report.ok, true);
  for (const check of report.checks) {
    assert.notEqual(check.level, "fail", `${check.id}: ${check.detail}`);
  }
  const ids = report.checks.map((c) => c.id);
  assert.deepEqual(
    ids,
    ["platform", "executable", "version", "roles", "settings", "cwd-read", "cwd-write", "file-rule-form", "command-rules", "sensitive-denies", "caveat"],
  );
  assert.match(report.text, /^Agy doctor for C:\\Users\\tester\\project$/m);
  assert.match(report.text, /11 ok, 0 warn, 0 fail$/);
});

test("runAgyDoctor: unverified CLI version 1.1.30 warns instead of failing", async () => {
  const exec = async (executable, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "1.1.30\n", stderr: "" };
    return WORKING_EXEC(executable, args);
  };
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env: syntheticWin32Env(),
    platform: "win32",
    exists: () => true,
    exec,
    readFile: WORKING_READ_FILE,
  });
  const versionCheck = report.checks.find((c) => c.id === "version");
  assert.equal(versionCheck.level, "warn");
  assert.match(versionCheck.detail, /1\.1\.30/);
  assert.match(versionCheck.detail, new RegExp(VERIFIED_AGY_CLI_VERSIONS.join(", ").replace(/\./g, "\\.")));
});

test("runAgyDoctor: missing 'researcher' role fails with the install fix", async () => {
  const exec = async (executable, args) => {
    if (args[0] === "agent") return { code: 0, stdout: "delegate\nscout\nworker\n", stderr: "" };
    return WORKING_EXEC(executable, args);
  };
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env: syntheticWin32Env(),
    platform: "win32",
    exists: () => true,
    exec,
    readFile: WORKING_READ_FILE,
  });
  const rolesCheck = report.checks.find((c) => c.id === "roles");
  assert.equal(rolesCheck.level, "fail");
  assert.match(rolesCheck.detail, /researcher/);
  assert.match(rolesCheck.fix, /install-agy-plugin/);
  assert.equal(report.ok, false);
  assert.equal(Object.values(REQUIRED_AGY_ROLES).length, 4);
});

test("runAgyDoctor: an exec that throws never escapes the doctor and fails those checks", async () => {
  const throwingExec = async () => {
    throw new Error("boom");
  };
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env: syntheticWin32Env(),
    platform: "win32",
    exists: () => true,
    exec: throwingExec,
    readFile: WORKING_READ_FILE,
  });
  const versionCheck = report.checks.find((c) => c.id === "version");
  const rolesCheck = report.checks.find((c) => c.id === "roles");
  assert.equal(versionCheck.level, "fail");
  assert.match(versionCheck.detail, /boom/);
  assert.equal(rolesCheck.level, "fail");
  assert.match(rolesCheck.detail, /boom/);
  assert.equal(report.ok, false);
});

test("runAgyDoctor: settings ENOENT fails settings and degrades cwd checks gracefully", async () => {
  const error = new Error("no such file");
  error.code = "ENOENT";
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env: syntheticWin32Env(),
    platform: "win32",
    exists: () => true,
    exec: WORKING_EXEC,
    readFile: async () => {
      throw error;
    },
  });
  const settingsCheck = report.checks.find((c) => c.id === "settings");
  const cwdReadCheck = report.checks.find((c) => c.id === "cwd-read");
  const cwdWriteCheck = report.checks.find((c) => c.id === "cwd-write");
  const commandRulesCheck = report.checks.find((c) => c.id === "command-rules");
  assert.equal(settingsCheck.level, "fail");
  assert.match(settingsCheck.detail, /ENOENT/);
  assert.equal(cwdReadCheck.level, "fail");
  assert.equal(cwdWriteCheck.level, "warn");
  assert.equal(commandRulesCheck.level, "warn");
  assert.equal(report.ok, false);
});

test("runAgyDoctor: an uncovered cwd fails with a fix naming the forward-slash cwd", async () => {
  const uncoveredSettings = {
    permissions: { allow: ["read_file(C:/Users/tester/other-project)", "command(git status)"] },
  };
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env: syntheticWin32Env(),
    platform: "win32",
    exists: () => true,
    exec: WORKING_EXEC,
    readFile: async () => JSON.stringify(uncoveredSettings),
  });
  const cwdReadCheck = report.checks.find((c) => c.id === "cwd-read");
  assert.equal(cwdReadCheck.level, "fail");
  assert.equal(cwdReadCheck.fix, "add read_file(C:/Users/tester/project) to permissions.allow");
  assert.equal(report.ok, false);
});

test("runAgyDoctor: missing required win32 source env names fails the platform check", async () => {
  const env = syntheticWin32Env();
  delete env.LOGONSERVER;
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env,
    platform: process.platform,
    exists: () => true,
    exec: WORKING_EXEC,
    readFile: WORKING_READ_FILE,
  });
  const platformCheck = report.checks.find((c) => c.id === "platform");
  if (process.platform === "win32") {
    // The win32 required-source-env gate only applies when the doctor is
    // actually simulating/running as win32; on this host it is real.
    assert.equal(platformCheck.level, "fail");
    assert.match(platformCheck.detail, /LOGONSERVER/);
    assert.deepEqual(
      REQUIRED_WIN32_NAMES.every((name) => typeof name === "string"),
      true,
    );
    assert.equal(report.ok, false);
  } else {
    // Off win32 the gate never runs regardless of the (irrelevant) env
    // contents, so the check must stay ok and the doctor must still not throw.
    assert.equal(platformCheck.level, "ok");
  }
});

test("runAgyDoctor: unresolved executable fails that check and skips version/roles", async () => {
  const report = await runAgyDoctor({
    cwd: "C:\\Users\\tester\\project",
    env: syntheticWin32Env({ AGY_CLI_PATH: undefined, PATH: "" }),
    platform: "win32",
    exists: () => false,
    exec: WORKING_EXEC,
    readFile: WORKING_READ_FILE,
  });
  const executableCheck = report.checks.find((c) => c.id === "executable");
  const versionCheck = report.checks.find((c) => c.id === "version");
  const rolesCheck = report.checks.find((c) => c.id === "roles");
  assert.equal(executableCheck.level, "fail");
  assert.equal(versionCheck.level, "fail");
  assert.match(versionCheck.detail, /not resolved/);
  assert.equal(rolesCheck.level, "fail");
  assert.equal(report.ok, false);
});
