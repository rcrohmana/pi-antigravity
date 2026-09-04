// Boundary: this module reads only the `permissions.allow` command rules
// (entries shaped `command(<target>)`) out of Agy's own local settings file
// (`%USERPROFILE%\.gemini\antigravity-cli\settings.json` on win32, or
// `$HOME/.gemini/antigravity-cli/settings.json` on linux/darwin). It never
// reads, parses for, or returns anything else from that file: no deny rules,
// no `trustedWorkspaces`, no credentials, no other key. The resulting list is
// advisory prompt text handed to the model so it does not blindly attempt
// commands that headless Agy would auto-deny; Agy's own permission engine
// remains the sole runtime authority over what actually executes.

import { readFile as nodeReadFile } from "node:fs/promises";
import { posix as posixPath, win32 as win32Path } from "node:path";

import { lookupEnvironmentValue } from "./env.ts";

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_COMMAND_RULES = 50;
const MAX_COMMAND_RULE_CHARS = 200;
const COMMAND_RULE_PATTERN = /^command\((.+)\)$/s;

export interface LoadAllowedCommandsOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  maxBytes?: number;
}

export interface LoadAllowedCommandsResult {
  commands: string[];
  source: "settings" | "unavailable";
  path?: string;
  reason?: string;
}

/**
 * Resolves the absolute path to Agy's own settings.json for the given source
 * environment/platform, or undefined when the platform's base-directory
 * variable (USERPROFILE on win32, HOME elsewhere) is absent. Lookups use the
 * shared case-insensitive-on-win32 helper from env.ts.
 */
export function resolveAgySettingsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    const userProfile = lookupEnvironmentValue(env, "USERPROFILE", platform);
    if (!userProfile) return undefined;
    return win32Path.join(userProfile, ".gemini", "antigravity-cli", "settings.json");
  }
  const home = lookupEnvironmentValue(env, "HOME", platform);
  if (!home) return undefined;
  return posixPath.join(home, ".gemini", "antigravity-cli", "settings.json");
}

/**
 * Extracts command allow-rule targets from a parsed settings.json value.
 * Reads only `permissions.allow`; every other key (deny rules,
 * trustedWorkspaces, credentials, etc.) is ignored and never touched. Keeps
 * only string entries shaped `command(<target>)`, trims each target,
 * de-duplicates while preserving order, caps the result at 50 entries, and
 * drops (never truncates) any target longer than 200 characters. Tolerant of
 * any malformed shape: always returns an array, never throws.
 */
export function parseCommandAllowRules(json: unknown): string[] {
  const targets: string[] = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) return targets;
  const permissions = (json as Record<string, unknown>).permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return targets;
  const allow = (permissions as Record<string, unknown>).allow;
  if (!Array.isArray(allow)) return targets;

  const seen = new Set<string>();
  for (const entry of allow) {
    if (targets.length >= MAX_COMMAND_RULES) break;
    if (typeof entry !== "string") continue;
    const match = COMMAND_RULE_PATTERN.exec(entry);
    if (!match) continue;
    const target = match[1].trim();
    if (!target || target.length > MAX_COMMAND_RULE_CHARS) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  return targets;
}

function describeReadError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "read error";
}

/**
 * Loads the owner's configured command allow-rule targets from Agy's own
 * settings file. Never throws: any failure (missing USERPROFILE/HOME,
 * missing file, oversized file, invalid JSON) yields
 * `{ commands: [], source: "unavailable", path?, reason }`, where `reason` is
 * always a short, non-secret description (e.g. "ENOENT", "invalid JSON",
 * "too large") and never file content.
 */
export async function loadAllowedCommands(options: LoadAllowedCommandsOptions = {}): Promise<LoadAllowedCommandsResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? ((path: string) => nodeReadFile(path, "utf8"));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const path = resolveAgySettingsPath(env, platform);
  if (!path) {
    return { commands: [], source: "unavailable", reason: platform === "win32" ? "USERPROFILE not set" : "HOME not set" };
  }

  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    return { commands: [], source: "unavailable", path, reason: describeReadError(error) };
  }

  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { commands: [], source: "unavailable", path, reason: "too large" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { commands: [], source: "unavailable", path, reason: "invalid JSON" };
  }

  return { commands: parseCommandAllowRules(parsed), source: "settings", path };
}
