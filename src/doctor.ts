// Agy preflight doctor. Catches misconfiguration BEFORE any quota is spent by
// checking, offline where possible, the same things that make a headless Agy
// run fail: an unresolved executable, an unverified CLI version, a missing
// role plugin, and Agy `permissions.allow`/`permissions.deny` rules that do
// not cover the current working directory or the documented sensitive paths.
//
// Boundary notes (mirrors src/agy-settings.ts and src/runner.ts):
// - This module only ever reads Agy's own settings.json for `permissions`
//   entries; it never modifies that file and never reads any other Agy
//   config (auth files, shared config, project-level grants).
// - Any real Agy process this module spawns (to run `--version` / `agent`)
//   uses the same allow-listed, minimal child environment as the rest of the
//   extension (buildAgyChildEnv), `shell: false`, and `windowsHide: true`.
// - runAgyDoctor() and preflightCwdCoverage() never throw: every failure is
//   surfaced as a `fail`-level DoctorCheck (or an `unavailable` result),
//   never an exception, so a caller can always render a report.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile as nodeReadFile } from "node:fs/promises";

import { assertSupportedAgyPlatform, buildAgyChildEnv, lookupEnvironmentValue, missingRequiredWin32SourceEnvNames } from "./env.ts";
import { resolveAgyExecutable } from "./runner.ts";
import { parseCommandAllowRules, resolveAgySettingsPath } from "./agy-settings.ts";

export const VERIFIED_AGY_CLI_VERSIONS = ["1.1.25", "1.1.26"] as const;
export const REQUIRED_AGY_ROLES = ["worker", "scout", "delegate", "researcher"] as const;

const MAX_FILE_RULES = 200;
const SETTINGS_MAX_BYTES = 256 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 15_000;
const MAX_COMMAND_RULES_SHOWN = 10;
const MAX_ERROR_EXCERPT_CHARS = 300;

// Section from docs/permissions.md's recommended `permissions.deny` list,
// relative to the home directory.
const SENSITIVE_HOME_SUFFIXES = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".gemini",
  ".npmrc",
  ".git-credentials",
  ".kube",
  ".docker",
  ".env",
  ".pi/agent",
] as const;

function boundedChars(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/**
 * Normalizes a rule target or candidate path for comparison: trims, converts
 * backslashes to forward slashes, collapses duplicate slashes, strips a
 * trailing slash (except a bare drive root like "C:/"), and lowercases on
 * win32. Pure and side-effect-free.
 */
export function normalizeRuleTarget(target: string, platform: NodeJS.Platform): string {
  let value = target.trim();
  value = value.replace(/\\/g, "/");
  value = value.replace(/\/{2,}/g, "/");
  if (value.length > 1 && value.endsWith("/") && !/^[A-Za-z]:\/$/.test(value)) {
    value = value.slice(0, -1);
  }
  if (platform === "win32") value = value.toLowerCase();
  return value;
}

/**
 * True when `candidatePath` is exactly `ruleTarget` or nested under it, after
 * normalizing both sides. An empty normalized rule target never covers
 * anything.
 */
export function isPathCoveredByRule(ruleTarget: string, candidatePath: string, platform: NodeJS.Platform): boolean {
  const target = normalizeRuleTarget(ruleTarget, platform);
  if (!target) return false;
  const candidate = normalizeRuleTarget(candidatePath, platform);
  return candidate === target || candidate.startsWith(`${target}/`);
}

function extractFileRulesFrom(json: unknown, listKey: "allow" | "deny", kind: "read_file" | "write_file"): string[] {
  const targets: string[] = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) return targets;
  const permissions = (json as Record<string, unknown>).permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return targets;
  const list = (permissions as Record<string, unknown>)[listKey];
  if (!Array.isArray(list)) return targets;

  const pattern = new RegExp(`^${kind}\\((.+)\\)$`, "s");
  const seen = new Set<string>();
  for (const entry of list) {
    if (targets.length >= MAX_FILE_RULES) break;
    if (typeof entry !== "string") continue;
    const match = pattern.exec(entry);
    if (!match) continue;
    const target = match[1]!.trim();
    if (!target) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  return targets;
}

/**
 * Extracts `read_file(<target>)`/`write_file(<target>)` allow-rule targets
 * from a parsed settings.json value, tolerant of any malformed shape (never
 * throws; always returns an array). Reads only `permissions.allow`, capped at
 * 200 entries.
 */
export function extractFileRules(json: unknown, kind: "read_file" | "write_file"): string[] {
  return extractFileRulesFrom(json, "allow", kind);
}

/**
 * True when `target` (after backslash-to-slash normalization) uses the only
 * empirically working Windows file-rule form: a drive letter followed by a
 * forward slash, e.g. "C:/Users/you/project" (see docs/permissions.md).
 */
export function isWellFormedWin32FileRule(target: string): boolean {
  return /^[A-Za-z]:\//.test(target.replace(/\\/g, "/"));
}

export interface PermissionAnalysis {
  readRules: string[];
  writeRules: string[];
  commandRules: string[];
  readCoveringRule?: string;
  writeCoveringRule?: string;
  /** win32 only: read/write targets that fail isWellFormedWin32FileRule(); empty elsewhere. */
  malformedFileRules: string[];
  /** read_file(...) targets found under permissions.deny. */
  denyRules: string[];
  /** Sensitive home-relative paths (docs/permissions.md list) with no covering deny rule. */
  missingSensitiveDenies: string[];
}

/**
 * Analyzes a parsed Agy settings.json value against one cwd, without touching
 * the filesystem or environment. `homeDir` (USERPROFILE on win32, HOME
 * elsewhere) is passed in explicitly rather than read from process.env so
 * this stays pure and directly testable; when omitted, sensitive-path
 * coverage is not evaluated (missingSensitiveDenies is empty).
 */
export function analyzePermissions(settingsJson: unknown, cwd: string, platform: NodeJS.Platform, homeDir?: string): PermissionAnalysis {
  const readRules = extractFileRules(settingsJson, "read_file");
  const writeRules = extractFileRules(settingsJson, "write_file");
  const commandRules = parseCommandAllowRules(settingsJson);
  const denyRules = extractFileRulesFrom(settingsJson, "deny", "read_file");

  const readCoveringRule = readRules.find((rule) => isPathCoveredByRule(rule, cwd, platform));
  const writeCoveringRule = writeRules.find((rule) => isPathCoveredByRule(rule, cwd, platform));

  const malformedFileRules =
    platform === "win32" ? Array.from(new Set([...readRules, ...writeRules])).filter((rule) => !isWellFormedWin32FileRule(rule)) : [];

  const missingSensitiveDenies: string[] = [];
  if (homeDir) {
    // Display form only (forward slashes, original case); comparison below
    // still goes through isPathCoveredByRule's own normalization.
    const baseDisplay = normalizeRuleTarget(homeDir, "linux");
    for (const suffix of SENSITIVE_HOME_SUFFIXES) {
      const target = `${baseDisplay}/${suffix}`;
      const covered = denyRules.some((rule) => isPathCoveredByRule(rule, target, platform));
      if (!covered) missingSensitiveDenies.push(target);
    }
  }

  return { readRules, writeRules, commandRules, readCoveringRule, writeCoveringRule, malformedFileRules, denyRules, missingSensitiveDenies };
}

function describeReadError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "read error";
}

export interface PreflightCwdCoverageOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
}

export interface PreflightCwdCoverageResult {
  source: "settings" | "unavailable";
  reason?: string;
  readCoveringRule?: string;
  writeCoveringRule?: string;
}

/**
 * Cheap, no-spawn cwd-coverage check: reads Agy's settings.json (same 256 KiB
 * cap as loadAllowedCommands) and reports whether a read_file/write_file rule
 * covers `cwd`. Never throws.
 */
export async function preflightCwdCoverage(options: PreflightCwdCoverageOptions): Promise<PreflightCwdCoverageResult> {
  try {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const readFile = options.readFile ?? ((path: string) => nodeReadFile(path, "utf8"));

    const path = resolveAgySettingsPath(env, platform);
    if (!path) {
      return { source: "unavailable", reason: platform === "win32" ? "USERPROFILE not set" : "HOME not set" };
    }

    let text: string;
    try {
      text = await readFile(path);
    } catch (error) {
      return { source: "unavailable", reason: describeReadError(error) };
    }

    if (Buffer.byteLength(text, "utf8") > SETTINGS_MAX_BYTES) {
      return { source: "unavailable", reason: "too large" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { source: "unavailable", reason: "invalid JSON" };
    }

    const analysis = analyzePermissions(parsed, options.cwd, platform);
    return { source: "settings", readCoveringRule: analysis.readCoveringRule, writeCoveringRule: analysis.writeCoveringRule };
  } catch (error) {
    return { source: "unavailable", reason: error instanceof Error ? error.message : "unknown error" };
  }
}

export interface DoctorCheck {
  id: string;
  level: "ok" | "warn" | "fail";
  title: string;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  text: string;
}

/** Executes one Agy CLI probe (e.g. `--version`, `agent`) and captures bounded output. Never throws by contract; injectable for tests. */
export type AgyExec = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const chars = Array.from(combined);
  let bytes = Buffer.byteLength(combined, "utf8");
  let start = 0;
  while (start < chars.length && bytes > maxBytes) {
    bytes -= Buffer.byteLength(chars[start]!, "utf8");
    start += 1;
  }
  return chars.slice(start).join("");
}

/**
 * Default AgyExec: spawns the resolved, absolute Agy executable with the same
 * sanitized child environment as runAgy() (buildAgyChildEnv), `shell: false`,
 * `windowsHide: true`, and bounded (64 KiB) captured output. Closed over
 * `platform` because buildAgyChildEnv requires it and AgyExec's own signature
 * intentionally stays a plain 4-argument shape for easy test injection.
 */
function createDefaultAgyExec(platform: NodeJS.Platform): AgyExec {
  return (executable, args, sourceEnv, timeoutMs) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let childEnv: NodeJS.ProcessEnv;
      try {
        childEnv = buildAgyChildEnv(sourceEnv, platform);
      } catch (error) {
        resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      let child;
      try {
        child = nodeSpawn(executable, args as string[], {
          env: childEnv,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill();
        } catch {
          // Best effort; the close/error handler still settles below.
        }
      }, timeoutMs);
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout = boundedAppend(stdout, chunk.toString(), MAX_EXEC_OUTPUT_BYTES);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = boundedAppend(stderr, chunk.toString(), MAX_EXEC_OUTPUT_BYTES);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: stderr || error.message });
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}

export interface RunAgyDoctorOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  exec?: AgyExec;
  exists?: (path: string) => boolean;
  timeoutMs?: number;
}

async function runCheck(id: string, title: string, fn: () => Promise<DoctorCheck> | DoctorCheck): Promise<DoctorCheck> {
  try {
    return await fn();
  } catch (error) {
    return {
      id,
      level: "fail",
      title,
      detail: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function renderDoctorText(cwd: string, checks: readonly DoctorCheck[]): string {
  const lines = [`Agy doctor for ${cwd}`];
  let okCount = 0;
  let warnCount = 0;
  let failCount = 0;
  for (const check of checks) {
    const tag = check.level === "ok" ? "[OK]" : check.level === "warn" ? "[WARN]" : "[FAIL]";
    if (check.level === "ok") okCount += 1;
    else if (check.level === "warn") warnCount += 1;
    else failCount += 1;
    lines.push(`${tag} ${check.title}: ${check.detail}`);
    if (check.fix) lines.push(`  fix: ${check.fix}`);
  }
  lines.push(`${okCount} ok, ${warnCount} warn, ${failCount} fail`);
  return lines.join("\n");
}

/**
 * Runs the full Agy preflight: platform/environment support, executable
 * resolution, CLI version, role plugin presence, settings-file readability,
 * cwd read/write coverage, Windows file-rule form, configured command rules,
 * and sensitive-path deny coverage. Never throws; every failure becomes a
 * `fail`-level DoctorCheck instead.
 */
export async function runAgyDoctor(options: RunAgyDoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  try {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const exec = options.exec ?? createDefaultAgyExec(platform);
    const exists = options.exists ?? existsSync;
    const readFile = options.readFile ?? ((path: string) => nodeReadFile(path, "utf8"));
    const displayCwd = normalizeRuleTarget(options.cwd, "linux");

    // platform
    checks.push(
      await runCheck("platform", "Platform support", () => {
        assertSupportedAgyPlatform(platform);
        if (platform === "win32") {
          const missing = missingRequiredWin32SourceEnvNames(env);
          if (missing.length > 0) {
            return {
              id: "platform",
              level: "fail",
              title: "Platform support",
              detail: `Missing required win32 source environment variables (names only): ${missing.join(", ")}`,
              fix: "Run from a normal Windows user shell that already has these variables set; never fabricate or hardcode them.",
            };
          }
        }
        return { id: "platform", level: "ok", title: "Platform support", detail: `platform=${platform}` };
      }),
    );

    // executable
    let executablePath: string | undefined;
    try {
      executablePath = resolveAgyExecutable(env, platform, exists);
      checks.push({ id: "executable", level: "ok", title: "Agy executable", detail: `Resolved: ${executablePath}` });
    } catch (error) {
      checks.push({
        id: "executable",
        level: "fail",
        title: "Agy executable",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Install agy or set AGY_CLI_PATH.",
      });
    }

    // version, roles
    if (executablePath) {
      const resolvedExecutable = executablePath;
      checks.push(
        await runCheck("version", "Agy CLI version", async () => {
          const result = await exec(resolvedExecutable, ["--version"], env, timeoutMs);
          const firstLine = (result.stdout || result.stderr || "").split(/\r?\n/)[0]?.trim() ?? "";
          if (!firstLine) {
            return {
              id: "version",
              level: "fail",
              title: "Agy CLI version",
              detail: `agy --version produced no usable output (exit code ${String(result.code)}). stderr: ${boundedChars(result.stderr, MAX_ERROR_EXCERPT_CHARS)}`,
            };
          }
          if ((VERIFIED_AGY_CLI_VERSIONS as readonly string[]).includes(firstLine)) {
            return { id: "version", level: "ok", title: "Agy CLI version", detail: `agy ${firstLine} (verified)` };
          }
          return {
            id: "version",
            level: "warn",
            title: "Agy CLI version",
            detail: `CLI ${firstLine} not yet verified with this extension (verified: ${VERIFIED_AGY_CLI_VERSIONS.join(", ")})`,
          };
        }),
      );

      checks.push(
        await runCheck("roles", "Agy role plugin", async () => {
          const result = await exec(resolvedExecutable, ["agent"], env, timeoutMs);
          const roles = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          const missing = REQUIRED_AGY_ROLES.filter((role) => !roles.includes(role));
          if (missing.length > 0) {
            return {
              id: "roles",
              level: "fail",
              title: "Agy role plugin",
              detail: `Missing required Agy agent roles: ${missing.join(", ")} (found: ${roles.join(", ") || "none"})`,
              fix: ".\\scripts\\install-agy-plugin.ps1 -ConfirmInstall (or `agy plugin install <path-to-agy-plugin>`)",
            };
          }
          return { id: "roles", level: "ok", title: "Agy role plugin", detail: `All required roles present: ${roles.join(", ")}` };
        }),
      );
    } else {
      checks.push({ id: "version", level: "fail", title: "Agy CLI version", detail: "Skipped: Agy executable was not resolved." });
      checks.push({ id: "roles", level: "fail", title: "Agy role plugin", detail: "Skipped: Agy executable was not resolved." });
    }

    // settings
    let settingsJson: unknown;
    let settingsOk = false;
    checks.push(
      await runCheck("settings", "Agy settings file", async () => {
        const settingsPath = resolveAgySettingsPath(env, platform);
        // Displayed with forward slashes: when the model echoes the report as
        // markdown, a backslash before "." (C:\Users\<you>\.gemini) is eaten
        // as an escape and the path renders wrong.
        const shownPath = settingsPath?.replace(/\\/g, "/");
        if (!settingsPath) {
          return {
            id: "settings",
            level: "fail",
            title: "Agy settings file",
            detail: platform === "win32" ? "USERPROFILE is not set; cannot locate settings.json" : "HOME is not set; cannot locate settings.json",
            fix: "See docs/permissions.md for the expected settings.json location and shape.",
          };
        }
        let text: string;
        try {
          text = await readFile(settingsPath);
        } catch (error) {
          return {
            id: "settings",
            level: "fail",
            title: "Agy settings file",
            detail: `Could not read ${shownPath}: ${describeReadError(error)}`,
            fix: "See docs/permissions.md for the expected settings.json location and shape.",
          };
        }
        if (Buffer.byteLength(text, "utf8") > SETTINGS_MAX_BYTES) {
          return {
            id: "settings",
            level: "fail",
            title: "Agy settings file",
            detail: `${shownPath} exceeds the ${SETTINGS_MAX_BYTES} byte read cap`,
            fix: "See docs/permissions.md for the expected settings.json location and shape.",
          };
        }
        try {
          settingsJson = JSON.parse(text);
        } catch {
          return {
            id: "settings",
            level: "fail",
            title: "Agy settings file",
            detail: `${shownPath} is not valid JSON`,
            fix: "See docs/permissions.md for the expected settings.json location and shape.",
          };
        }
        settingsOk = true;
        return { id: "settings", level: "ok", title: "Agy settings file", detail: `Parsed ${shownPath}` };
      }),
    );

    if (!settingsOk) {
      checks.push({
        id: "cwd-read",
        level: "fail",
        title: "Workspace read coverage",
        detail: "Agy settings were not available; cannot confirm a read_file rule covers the workspace.",
        fix: `add read_file(${displayCwd}) to permissions.allow`,
      });
      checks.push({
        id: "cwd-write",
        level: "warn",
        title: "Workspace write coverage",
        detail: "Agy settings were not available; cannot confirm a write_file rule covers the workspace.",
        fix: `add write_file(${displayCwd}) to permissions.allow`,
      });
      if (platform === "win32") {
        checks.push({
          id: "file-rule-form",
          level: "warn",
          title: "File rule form",
          detail: "Agy settings were not available; cannot check file rule form.",
        });
      }
      checks.push({
        id: "command-rules",
        level: "warn",
        title: "Command allow rules",
        detail: "Agy settings were not available; cannot list command allow rules.",
      });
      checks.push({
        id: "sensitive-denies",
        level: "warn",
        title: "Sensitive path denies",
        detail: "Agy settings were not available; cannot check sensitive-path denies.",
      });
    } else {
      const homeDir = lookupEnvironmentValue(env, platform === "win32" ? "USERPROFILE" : "HOME", platform);
      const analysis = analyzePermissions(settingsJson, options.cwd, platform, homeDir);

      checks.push(
        analysis.readCoveringRule
          ? { id: "cwd-read", level: "ok", title: "Workspace read coverage", detail: `cwd is covered by read_file(${analysis.readCoveringRule})` }
          : {
              id: "cwd-read",
              level: "fail",
              title: "Workspace read coverage",
              detail: "No read_file rule covers the workspace; headless roles will be auto-denied on any local read.",
              fix: `add read_file(${displayCwd}) to permissions.allow`,
            },
      );

      checks.push(
        analysis.writeCoveringRule
          ? { id: "cwd-write", level: "ok", title: "Workspace write coverage", detail: `cwd is covered by write_file(${analysis.writeCoveringRule})` }
          : {
              id: "cwd-write",
              level: "warn",
              title: "Workspace write coverage",
              detail: "No write_file rule covers the workspace; worker/delegate writes will be denied.",
              fix: `add write_file(${displayCwd}) to permissions.allow`,
            },
      );

      if (platform === "win32") {
        checks.push(
          analysis.malformedFileRules.length > 0
            ? {
                id: "file-rule-form",
                level: "warn",
                title: "File rule form",
                detail: `These rule targets do not use the proven drive-letter forward-slash form and will not match: ${analysis.malformedFileRules.join(", ")}`,
                fix: "Use the form read_file(C:/Users/<you>/...) or write_file(C:/Users/<you>/...) — drive letter plus forward slashes.",
              }
            : {
                id: "file-rule-form",
                level: "ok",
                title: "File rule form",
                detail: "All read_file/write_file rule targets use the drive-letter forward-slash form.",
              },
        );
      }

      const shownCommandRules = analysis.commandRules.slice(0, MAX_COMMAND_RULES_SHOWN);
      checks.push(
        analysis.commandRules.length === 0
          ? {
              id: "command-rules",
              level: "warn",
              title: "Command allow rules",
              detail: "No command() allow rules are configured; worker/delegate will be told to run no commands.",
            }
          : {
              id: "command-rules",
              level: "ok",
              title: "Command allow rules",
              detail: `${analysis.commandRules.length} command allow rule(s) configured${analysis.commandRules.length > MAX_COMMAND_RULES_SHOWN ? " (showing first 10)" : ""}: ${shownCommandRules.join(", ")}`,
            },
      );

      checks.push(
        analysis.missingSensitiveDenies.length > 0
          ? {
              id: "sensitive-denies",
              level: "warn",
              title: "Sensitive path denies",
              detail: `No deny rule covers these sensitive paths: ${analysis.missingSensitiveDenies.join(", ")}`,
              fix: "Add read_file(<path>) entries under permissions.deny for each; see docs/permissions.md.",
            }
          : {
              id: "sensitive-denies",
              level: "ok",
              title: "Sensitive path denies",
              detail: "All documented sensitive paths are covered by a deny rule.",
            },
      );
    }

    checks.push({
      id: "caveat",
      level: "ok",
      title: "Scope caveat",
      detail:
        "Rules from Agy shared config (~/.gemini/config/config.json) or project permission grants are not inspected; headless runs use the same settings file this doctor read.",
    });

    const ok = !checks.some((check) => check.level === "fail");
    return { ok, checks, text: renderDoctorText(options.cwd, checks) };
  } catch (error) {
    const failure: DoctorCheck = {
      id: "doctor",
      level: "fail",
      title: "Agy doctor",
      detail: `Unexpected error while running the doctor: ${error instanceof Error ? error.message : String(error)}`,
    };
    return { ok: false, checks: [failure], text: renderDoctorText(options.cwd, [failure]) };
  }
}
