import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { posix as posixPath, win32 as win32Path } from "node:path";

import {
  AgyRunnerError,
  type AgyDeniedAction,
  type AgyDeniedTool,
  type AgyInitEvent,
  type AgyResultEvent,
  type AgyRetryInfo,
  type AgyRunSummary,
  type AgyStatus,
  type AgyStreamEvent,
  type AgyStepUpdateEvent,
  type AgyStepUpdatePayload,
  type AgyUsage,
  boundPiOutput,
} from "./schemas.ts";
import { assertSupportedAgyPlatform, buildAgyChildEnv, lookupEnvironmentValue, missingRequiredWin32SourceEnvNames } from "./env.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_DIAGNOSTICS_CHARS = 16 * 1024;
const MAX_NDJSON_LINE_BYTES = 1 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_500;
const PERMISSION_ESCALATION_PATTERN = /\b(?:permission(?:\s+request)?\s+(?:denied|required|blocked)|approval\s+(?:required|denied)|soft[- ]denied|auto[- ]denied|cannot prompt|headless mode cannot prompt|(?:tool|command|action)\b[^\n]{0,100}\bdenied\b|not allowed to)\b/i;

export interface RunnerProgress {
  event: "init" | "step_update";
  conversationId?: string;
  stepType?: string;
  textDelta?: string;
  usage?: AgyUsage;
}

export interface AgyRunOptions {
  role: string;
  task: string;
  cwd: string;
  context?: string;
  files?: readonly string[];
  executable?: string;
  /**
   * Test/injection hook: the source parent environment to sanitize, never an
   * exact child-environment override. It is read only for executable
   * resolution and allow-listed variable copying; the child receives a fresh
   * allow-listed environment built from it.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Internal/test hook for the selected platform. Defaults to
   * `process.platform`; `runAgy()` fails closed when it differs from the host
   * platform, because libuv injection and path semantics follow the actual
   * host. Pure cross-platform simulation belongs in the `resolveAgyExecutable()`
   * and `buildAgyChildEnv()` helper tests, which keep their platform
   * parameters.
   */
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  conversationId?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  onProgress?: (progress: RunnerProgress) => void;
  spawnImpl?: typeof nodeSpawn;
  mode?: "default" | "accept-edits";
  /**
   * Command policy for write-capable roles. When defined (even empty), the
   * prompt gains a "Command policy" block listing the exact command allow-rule
   * targets configured in Agy; anything else is auto-denied headlessly. Leave
   * undefined for roles without `run_command`.
   */
  allowedCommands?: readonly string[];
  /** Role-limit paragraph placed in the prompt so the role degrades gracefully instead of guessing. */
  roleLimits?: string;
  exists?: (path: string) => boolean;
  /** Test hook and host-specific process-tree termination override. */
  killImpl?: (child: ChildProcess, platform: NodeJS.Platform) => void;
}

interface LineParser {
  push(chunk: string): AgyStreamEvent[];
  finish(): AgyStreamEvent[];
}

export class NdjsonParser implements LineParser {
  private buffer = "";
  private readonly maxLineBytes: number;

  constructor(maxLineBytes = MAX_NDJSON_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: string): AgyStreamEvent[] {
    this.buffer += chunk;
    const events: AgyStreamEvent[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const event = parseNdjsonLine(line, this.maxLineBytes);
      if (event) events.push(event);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      throw new AgyRunnerError("protocol_error", "Agy emitted an NDJSON line larger than the safety limit");
    }
    return events;
  }

  finish(): AgyStreamEvent[] {
    if (this.buffer.trim() === "") {
      this.buffer = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    const event = parseNdjsonLine(line, this.maxLineBytes);
    return event ? [event] : [];
  }
}

export function parseNdjsonLine(line: string, maxLineBytes = MAX_NDJSON_LINE_BYTES): AgyStreamEvent | undefined {
  if (line.trim() === "") return undefined;
  if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
    throw new AgyRunnerError("protocol_error", "Agy emitted an NDJSON line larger than the safety limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new AgyRunnerError("protocol_error", `Malformed Agy NDJSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgyRunnerError("protocol_error", "Agy NDJSON event must be a JSON object");
  }
  const event = (value as { event?: unknown }).event;
  if (event === "init" && isObject((value as { init?: unknown }).init)) {
    return value as AgyInitEvent;
  }
  if (event === "step_update" && isObject((value as { step_update?: unknown }).step_update)) {
    return value as AgyStepUpdateEvent;
  }
  if (event === "result" && isObject((value as { result?: unknown }).result)) {
    return value as AgyResultEvent;
  }
  throw new AgyRunnerError("protocol_error", `Unsupported or malformed Agy stream event: ${String(event)}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

class BoundedText {
  private value = "";
  append(chunk: string): void {
    if (!chunk) return;
    this.value += chunk;
    if (this.value.length > MAX_DIAGNOSTICS_CHARS) {
      this.value = `[diagnostics truncated]\n${this.value.slice(-MAX_DIAGNOSTICS_CHARS)}`;
    }
  }
  toString(): string {
    return this.value.trim();
  }
}

export interface AgyPromptPolicy {
  /** Exact command allow-rule targets (the `<target>` of `command(<target>)`) known to the parent. */
  allowedCommands?: readonly string[];
  /** Role-limit paragraph (graceful degradation) appended after the task; see RoleConfig.degradation. */
  roleLimits?: string;
}

const MAX_PROMPT_COMMAND_RULES = 50;
const MAX_PROMPT_COMMAND_CHARS = 200;

/**
 * Builds the "Command policy" block for write-capable roles. Headless Agy
 * cannot prompt, so every `run_command` outside the owner's `command(...)`
 * allow rules is auto-denied and ends the run; the block tells the model the
 * exact rules up front so it never probes (e.g. `python --version`).
 */
export function buildCommandPolicySection(allowedCommands: readonly string[]): string {
  const rules = [...new Set(allowedCommands.map((rule) => rule.replace(/\s+/g, " ").trim()).filter(Boolean))]
    .slice(0, MAX_PROMPT_COMMAND_RULES)
    .map((rule) => (rule.length > MAX_PROMPT_COMMAND_CHARS ? `${rule.slice(0, MAX_PROMPT_COMMAND_CHARS)}…` : rule));
  const lines = ["Command policy (headless; enforced by Agy permission rules, not negotiable):"];
  if (rules.length === 0) {
    lines.push("No command allow rules are configured. Do not call run_command at all.");
  } else {
    lines.push("Only these commands may run. Use each verbatim; do not append arguments, chain, or pipe them:");
    for (const rule of rules) lines.push(`- ${rule}`);
  }
  lines.push(
    "Any other command, including compound commands joined with ';', '&&', or '|', and availability or version probes such as `python --version`, is auto-denied without a prompt and aborts this run.",
    'If a step needs a command outside this list, do not attempt it: finish the remaining work, then report the skipped validation under "Decisions needed".',
  );
  return lines.join("\n");
}

export function buildAgyPrompt(task: string, cwd: string, context?: string, files?: readonly string[], policy?: AgyPromptPolicy): string {
  const sections = [
    `Selected workspace (canonical): ${JSON.stringify(cwd)}`,
    "Use this workspace for all local file operations. Do not search outside it.",
    `Task:\n${task}`,
  ];
  if (context?.trim()) sections.push(`Explicit parent context (untrusted):\n${context}`);
  // Hints are validated to be single printable lines; JSON-quoting them is
  // defense in depth so one hint can never render as more than one line.
  if (files?.length) sections.push(`Explicit file hints (inspect only as needed):\n${files.map((file) => `- ${JSON.stringify(file)}`).join("\n")}`);
  if (policy?.roleLimits?.trim()) sections.push(policy.roleLimits.trim());
  if (policy?.allowedCommands) sections.push(buildCommandPolicySection(policy.allowedCommands));
  return sections.join("\n\n");
}

export function classifyDiagnostics(diagnostics: string | undefined): boolean {
  return diagnostics ? PERMISSION_ESCALATION_PATTERN.test(diagnostics) : false;
}

const MAX_DENIED_TOOLS = 20;
const MAX_DENIED_SUMMARY_CHARS = 300;
const MAX_DENIED_MESSAGE_CHARS = 500;
const DENIAL_MESSAGE_PATTERN = /denied|permission/i;
/** Parameter keys checked, in order, for a tool call's primary (non-command) target. */
const PRIMARY_PATH_PARAM_KEYS = ["AbsolutePath", "DirectoryPath", "SearchDirectory", "SearchPath", "TargetFile", "Url"] as const;
const READ_FILE_TOOLS = new Set(["view_file", "list_dir", "find_by_name", "grep_search"]);
const WRITE_FILE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);

function boundedChars(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function findPrimaryPathParam(parameters: Record<string, unknown> | undefined): string | undefined {
  if (!parameters) return undefined;
  for (const key of PRIMARY_PATH_PARAM_KEYS) {
    const value = parameters[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function describeDeniedToolSummary(toolName: string | undefined, parameters: Record<string, unknown> | undefined): string {
  if (toolName === "run_command" && typeof parameters?.CommandLine === "string" && parameters.CommandLine) {
    return boundedChars(parameters.CommandLine, MAX_DENIED_SUMMARY_CHARS);
  }
  const path = findPrimaryPathParam(parameters);
  if (path) return boundedChars(path, MAX_DENIED_SUMMARY_CHARS);
  if (parameters && Object.keys(parameters).length > 0) {
    try {
      return boundedChars(JSON.stringify(parameters), MAX_DENIED_SUMMARY_CHARS);
    } catch {
      // fall through to the no-parameters case below.
    }
  }
  return "(no parameters)";
}

function describeDeniedToolSuggestedRule(toolName: string | undefined, parameters: Record<string, unknown> | undefined): string | undefined {
  if (!toolName) return undefined;
  if (toolName === "run_command") {
    const commandLine = typeof parameters?.CommandLine === "string" ? parameters.CommandLine : undefined;
    return commandLine ? `command(${commandLine})` : undefined;
  }
  if (READ_FILE_TOOLS.has(toolName)) {
    const path = findPrimaryPathParam(parameters);
    return path ? `read_file(${path.replace(/\\/g, "/")})` : undefined;
  }
  if (WRITE_FILE_TOOLS.has(toolName)) {
    const path = findPrimaryPathParam(parameters);
    return path ? `write_file(${path.replace(/\\/g, "/")})` : undefined;
  }
  if (toolName === "read_url_content") {
    const url = typeof parameters?.Url === "string" ? parameters.Url : undefined;
    if (!url) return undefined;
    try {
      return `read_url(${new URL(url).hostname})`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Distills one ERROR-state tool step into an actionable denial summary. Pure
 * and side-effect-free, so it is directly unit-testable; only ever reads the
 * bounded parameter/error fields it needs and never retains the full payload.
 */
export function describeDeniedTool(step: AgyStepUpdatePayload): AgyDeniedTool | undefined {
  if (step.step_type !== "tool" || step.state !== "ERROR") return undefined;
  const toolInfo = step.tool_info;
  if (!toolInfo || typeof toolInfo !== "object" || Array.isArray(toolInfo)) return undefined;
  const info = toolInfo as { name?: unknown; parameters?: unknown; error?: unknown };
  const errorInfo = info.error;
  const message =
    errorInfo && typeof errorInfo === "object" && !Array.isArray(errorInfo) && typeof (errorInfo as { message?: unknown }).message === "string"
      ? ((errorInfo as { message: string }).message)
      : undefined;
  if (!message || !DENIAL_MESSAGE_PATTERN.test(message)) return undefined;
  const toolName = typeof info.name === "string" && info.name ? info.name : typeof step.tool_name === "string" ? step.tool_name : "unknown_tool";
  const parameters =
    info.parameters && typeof info.parameters === "object" && !Array.isArray(info.parameters)
      ? (info.parameters as Record<string, unknown>)
      : undefined;
  return {
    toolName,
    summary: describeDeniedToolSummary(toolName, parameters),
    message: boundedChars(message, MAX_DENIED_MESSAGE_CHARS),
    suggestedRule: describeDeniedToolSuggestedRule(toolName, parameters),
  };
}

/**
 * Renders a compact, actionable notice for one or more headless permission
 * denials: what was denied, why, and the exact allow-rule to add.
 */
export function formatPermissionDenialNotice(input: {
  deniedTools: readonly AgyDeniedTool[];
  deniedActions?: readonly { action?: string; displayName?: string }[];
}): string {
  const deniedTools = input.deniedTools ?? [];
  const deniedActions = input.deniedActions ?? [];
  const lines = ["Headless permission denial: Agy cannot prompt in this mode, so the call was auto-denied and the run stopped."];
  if (deniedTools.length > 0) {
    for (const tool of deniedTools) {
      const reason = (tool.message ?? "permission denied").replace(/\s+/g, " ").trim();
      lines.push(`- ${tool.toolName} \`${tool.summary}\` -> ${reason}`);
      if (tool.suggestedRule) lines.push(`  suggested allow rule: ${tool.suggestedRule}`);
    }
  } else if (deniedActions.length > 0) {
    for (const action of deniedActions) {
      const name = action.action ?? "unknown";
      const display = action.displayName ? ` (${action.displayName})` : "";
      lines.push(`- ${name}${display}`);
    }
    lines.push("Generic allow rule form: command(<target>) / read_file(C:/...) / read_url(<host>)");
  }
  lines.push(
    "Fix: add a matching rule under permissions.allow in Agy settings (%USERPROFILE%\\.gemini\\antigravity-cli\\settings.json on Windows, ~/.gemini/antigravity-cli/settings.json elsewhere), or rephrase the task so the tool is not needed. File rules must use the drive-letter forward-slash form, e.g. read_file(C:/Users/<you>/project). Do not disable Agy permission checks.",
  );
  return lines.join("\n");
}

const STDERR_PERMISSION_PATTERN = /required the "([a-z_]+)" permission/gi;

/**
 * Derives denied permission categories from Agy's headless stderr line
 * (`... required the "command" permission that headless mode cannot prompt for ...`)
 * for runs whose stream carried no per-step denial evidence.
 */
export function deniedActionsFromDiagnostics(diagnostics: string | undefined): AgyDeniedAction[] {
  if (!diagnostics) return [];
  const seen = new Set<string>();
  const actions: AgyDeniedAction[] = [];
  for (const match of diagnostics.matchAll(STDERR_PERMISSION_PATTERN)) {
    const action = match[1]?.toLowerCase();
    if (!action || seen.has(action)) continue;
    seen.add(action);
    actions.push({ action });
    if (actions.length >= MAX_DENIED_TOOLS) break;
  }
  return actions;
}

/** One-paragraph, model-visible summary of a bounded auto-retry after a headless denial. */
export function formatRetryNotice(retry: AgyRetryInfo): string {
  const denied = retry.firstAttemptDeniedTools.map(
    (tool) => `${tool.toolName} \`${tool.summary}\`${tool.suggestedRule ? ` (suggested rule: ${tool.suggestedRule})` : ""}`,
  );
  const actions = retry.firstAttemptDeniedActions.map((action) => `${action.action ?? "unknown"} permission${action.displayName ? ` (${action.displayName})` : ""}`);
  const what = denied.length ? denied.join("; ") : actions.length ? actions.join("; ") : "a tool call (see first-attempt diagnostics)";
  return [
    `[Agy auto-retry] The first attempt (status ${retry.firstAttemptStatus}) was auto-denied headlessly for: ${what}.`,
    "The same Agy conversation was continued once with an instruction not to call it again; the result below is from that continuation. The owner can still add the suggested allow rule so future runs may use the tool.",
  ].join("\n");
}

export function formatModelVisibleResponse(run: Pick<AgyRunSummary, "response" | "diagnostics" | "escalationRequired" | "retry">): string {
  const response = run.response.trimEnd();
  const diagnostics = run.diagnostics?.trim();
  const retryNotice = run.retry ? formatRetryNotice(run.retry) : undefined;
  if (!diagnostics) return boundPiOutput(response, retryNotice);
  const heading = run.escalationRequired ? "[ESCALATION REQUIRED: Agy permission/approval notice]" : "[Agy diagnostics]";
  const notice = `${retryNotice ? `${retryNotice}\n\n` : ""}${heading}\n${diagnostics}`;
  return boundPiOutput(response, notice);
}

export function buildAgyArgs(options: AgyRunOptions, timeoutMs: number): string[] {
  // The prompt is sent over stdin below, not argv: Windows CreateProcess has a
  // roughly 32K command-line limit and context is intentionally allowed to be larger.
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--agent",
    options.role,
    "--print-timeout",
    `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`,
  ];
  if (options.mode && options.mode !== "default") args.push("--mode", options.mode);
  if (options.conversationId) args.push("--conversation", options.conversationId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  return args;
}

/** Platform-aware path helpers so resolution semantics follow the selected platform. */
function pathImplFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32Path : posixPath;
}

/**
 * Resolves the absolute path of the official Agy executable from the source
 * environment: AGY_CLI_PATH, then PATH, then the Windows LOCALAPPDATA/
 * USERPROFILE fallback. Lookups use the shared platform-aware helper, so
 * Windows resolves case-insensitively with deterministic precedence and other
 * platforms stay case-sensitive. Every accepted candidate is normalized to an
 * absolute path before it is returned.
 */
export function resolveAgyExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const pathImpl = pathImplFor(platform);
  const configured = lookupEnvironmentValue(env, "AGY_CLI_PATH", platform)?.trim();
  if (configured) {
    const configuredPath = findCandidate(configured, env, platform, exists);
    if (configuredPath) return configuredPath;
  }

  const pathValue = lookupEnvironmentValue(env, "PATH", platform) ?? "";
  const pathEntries = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = pathImpl.resolve(pathImpl.join(entry, name));
      if (exists(candidate)) return candidate;
    }
  }

  if (platform === "win32") {
    const localAppData = lookupEnvironmentValue(env, "LOCALAPPDATA", platform);
    const userProfile = lookupEnvironmentValue(env, "USERPROFILE", platform);
    const base = localAppData ?? (userProfile ? pathImpl.join(userProfile, "AppData", "Local") : undefined);
    if (base) {
      const fallback = pathImpl.resolve(pathImpl.join(base, "agy", "bin", "agy.exe"));
      if (exists(fallback)) return fallback;
    }
  }
  throw new AgyRunnerError(
    "executable_not_found",
    "Could not locate agy.exe. Set AGY_CLI_PATH, update PATH, or install the official CLI under %LOCALAPPDATA%\\agy\\bin.",
  );
}

function findCandidate(
  value: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | undefined {
  const pathImpl = pathImplFor(platform);
  if (pathImpl.isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    const candidate = pathImpl.resolve(value);
    return exists(candidate) ? candidate : undefined;
  }
  const pathEntries = (lookupEnvironmentValue(env, "PATH", platform) ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" && !value.toLowerCase().endsWith(".exe") ? [value + ".exe", value] : [value];
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = pathImpl.resolve(pathImpl.join(entry, name));
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves the executable for one run. options.executable must be an absolute
 * path for every invocation — including injected fake spawn implementations —
 * so no spawn path can ever receive a bare executable name that Node might
 * resolve through an ambient command search.
 */
function resolveRunExecutable(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: AgyRunOptions,
): string {
  if (options.executable !== undefined) {
    if (!pathImplFor(platform).isAbsolute(options.executable)) {
      throw new AgyRunnerError(
        "executable_not_found",
        "options.executable must be an absolute path for every Agy spawn, including injected test spawn implementations",
      );
    }
    return options.executable;
  }
  const executable = resolveAgyExecutable(parentEnv, platform, options.exists);
  if (!pathImplFor(platform).isAbsolute(executable)) {
    throw new AgyRunnerError("executable_not_found", "Resolved Agy executable is not an absolute path; refusing to spawn");
  }
  return executable;
}

export async function runAgy(options: AgyRunOptions): Promise<AgyRunSummary> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive finite number");
  if (options.signal?.aborted) throw new AgyRunnerError("aborted", "Agy delegation was canceled before start");
  // A-04: the source environment is used only to resolve the executable and
  // to copy allow-listed variables; it is never passed to spawn() directly.
  const platform = options.platform ?? process.platform;
  // Fail closed on unsupported platforms and on host mismatches before any
  // environment lookup, executable resolution, or process creation. libuv
  // injection and path semantics follow the actual host, not the option, so a
  // simulated platform string must never steer the real host spawn.
  assertSupportedAgyPlatform(platform);
  if (platform !== process.platform) {
    throw new Error(
      `Agy platform "${platform}" does not match the host platform "${process.platform}"; runner integration is native-host only`,
    );
  }
  const parentEnv = options.env ?? process.env;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  // On win32, libuv copies a fixed set of variables from ambient process.env
  // into every child whose spawn options omit them. Every Agy run on win32
  // therefore requires all of those names in the requested source environment,
  // regardless of which spawn implementation is injected: a wrapper around the
  // default spawn could still reach the real process. The gate fails closed
  // before executable resolution and spawn with names-only diagnostics.
  if (platform === "win32") {
    const missing = missingRequiredWin32SourceEnvNames(parentEnv);
    if (missing.length) {
      throw new AgyRunnerError(
        "spawn_error",
        `Agy spawn blocked on win32: required environment variables are missing from the source environment (names only): ${missing.join(", ")}`,
      );
    }
  }
  const executable = resolveRunExecutable(parentEnv, platform, options);
  const childEnv = buildAgyChildEnv(parentEnv, platform);
  const args = buildAgyArgs(options, timeoutMs);
  const diagnostics = new BoundedText();
  const parser = new NdjsonParser();
  const startedAt = Date.now();
  let resultEvent: AgyResultEvent | undefined;
  let conversationId: string | undefined;
  let lastUsage: AgyUsage | undefined;
  const deniedTools: AgyDeniedTool[] = [];
  const seenDeniedToolKeys = new Set<string>();
  let deniedActions: AgyDeniedAction[] = [];
  let proc: ChildProcess;
  let settled = false;
  let closeSeen = false;
  let terminationReason: "timeout" | "aborted" | undefined;
  let terminationStarted = false;
  let pendingFailure: AgyRunnerError | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let terminationHandle: ReturnType<typeof setTimeout> | undefined;
  let forceTermination: (() => void) | undefined;

  const processEvent = (event: AgyStreamEvent): void => {
    if (event.event === "init") {
      conversationId = event.init.conversation_id ?? event.conversation_id;
      options.onProgress?.({ event: "init", conversationId });
      return;
    }
    if (event.event === "step_update") {
      const step = event.step_update;
      conversationId = step.conversation_id ?? conversationId;
      lastUsage = step.usage ?? lastUsage;
      options.onProgress?.({
        event: "step_update",
        conversationId,
        stepType: step.step_type,
        textDelta: step.text_delta,
        usage: step.usage,
      });
      if (step.step_type === "tool" && step.state === "ERROR" && deniedTools.length < MAX_DENIED_TOOLS) {
        const denied = describeDeniedTool(step);
        if (denied) {
          const key = `${denied.toolName}\u0000${denied.summary}`;
          if (!seenDeniedToolKeys.has(key)) {
            seenDeniedToolKeys.add(key);
            deniedTools.push(denied);
          }
        }
      }
      return;
    }
    resultEvent = event;
    conversationId = event.result.conversation_id ?? conversationId;
    lastUsage = event.result.usage ?? lastUsage;
    if (Array.isArray(event.result.denied_actions)) {
      deniedActions = event.result.denied_actions.slice(0, MAX_DENIED_TOOLS).map((action) => ({
        action: typeof action?.action === "string" ? action.action : undefined,
        displayName: typeof action?.display_name === "string" ? action.display_name : undefined,
      }));
    }
  };

  const cleanup = (): void => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (terminationHandle) clearTimeout(terminationHandle);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const rejectWith = (reject: (error: unknown) => void, error: AgyRunnerError): void => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };

  const terminate = (): void => {
    if (!proc || closeSeen || terminationStarted) return;
    terminationStarted = true;
    try {
      if (options.killImpl) options.killImpl(proc, platform);
      else terminateProcessTree(proc, platform);
    } catch {
      // The close/error event below remains authoritative.
    }
    terminationHandle = setTimeout(() => {
      if (closeSeen || settled) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        // Best effort; settle below so callers never wait forever.
      }
      forceTermination?.();
    }, TERMINATION_GRACE_MS);
  };

  const onAbort = (): void => {
    if (settled) return;
    terminationReason = "aborted";
    terminate();
  };

  return new Promise<AgyRunSummary>((resolvePromise, reject) => {
    forceTermination = () => {
      if (pendingFailure) {
        rejectWith(reject, pendingFailure);
        return;
      }
      const reason = terminationReason === "timeout" ? "timeout" : "aborted";
      const message = reason === "timeout" ? `Agy delegation exceeded ${timeoutMs}ms` : "Agy delegation was canceled";
      rejectWith(reject, new AgyRunnerError(reason, message, { diagnostics: diagnostics.toString() }));
    };
    try {
      proc = spawnImpl(executable, args, {
        cwd: options.cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      rejectWith(reject, new AgyRunnerError("spawn_error", `Unable to start agy: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const onStdout = (chunk: string | Buffer): void => {
      if (settled || pendingFailure) return;
      try {
        for (const event of parser.push(chunk.toString())) processEvent(event);
      } catch (error) {
        pendingFailure =
          error instanceof AgyRunnerError
            ? new AgyRunnerError(error.code, error.message, {
                diagnostics: diagnostics.toString() || error.diagnostics,
                status: error.status,
                exitCode: error.exitCode,
              })
            : new AgyRunnerError("protocol_error", String(error), { diagnostics: diagnostics.toString() });
        terminate();
        /* Keep termination timers alive until close or the forced-kill fallback. */
        /* Do not reject here: a failed first kill must not orphan the child. */
        /* The close handler or forceTermination rejects with pendingFailure. */
      }
    };
    const onStderr = (chunk: string | Buffer): void => diagnostics.append(chunk.toString());
    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);

    const onStdinError = (error: Error): void => {
      if (settled || pendingFailure) return;
      pendingFailure = new AgyRunnerError("spawn_error", `Unable to send task to agy: ${error.message}`, { diagnostics: diagnostics.toString() });
      terminate();
    };
    proc.stdin?.once("error", onStdinError);

    proc.once("error", (error) => {
      rejectWith(reject, new AgyRunnerError("spawn_error", `Agy process error: ${error.message}`, { diagnostics: diagnostics.toString() }));
    });
    proc.once("close", (code, signal) => {
      closeSeen = true;
      if (pendingFailure) {
        rejectWith(reject, pendingFailure);
        return;
      }
      try {
        for (const event of parser.finish()) processEvent(event);
      } catch (error) {
        rejectWith(
          reject,
          error instanceof AgyRunnerError
            ? new AgyRunnerError(error.code, error.message, {
                diagnostics: diagnostics.toString() || error.diagnostics,
                status: error.status,
                exitCode: error.exitCode ?? code,
              })
            : new AgyRunnerError("protocol_error", String(error), { diagnostics: diagnostics.toString(), exitCode: code }),
        );
        return;
      }
      if (terminationReason === "aborted") {
        rejectWith(reject, new AgyRunnerError("aborted", "Agy delegation was canceled", { diagnostics: diagnostics.toString(), exitCode: code }));
        return;
      }
      if (terminationReason === "timeout") {
        rejectWith(reject, new AgyRunnerError("timeout", `Agy delegation exceeded ${timeoutMs}ms`, { diagnostics: diagnostics.toString(), exitCode: code }));
        return;
      }
      if (!resultEvent) {
        rejectWith(reject, new AgyRunnerError("missing_result", "Agy exited without a terminal result event", { diagnostics: diagnostics.toString(), exitCode: code }));
        return;
      }
      const result = resultEvent.result;
      const status = result.status;
      const stderrText = diagnostics.toString();
      const hasDeniedEvidence = deniedTools.length > 0 || deniedActions.length > 0;
      const notice = hasDeniedEvidence ? formatPermissionDenialNotice({ deniedTools, deniedActions }) : undefined;
      // A CANCELED trajectory can end before the denied step's ERROR update is
      // streamed; the stderr line is then the only evidence of the category.
      if (deniedTools.length === 0 && deniedActions.length === 0) deniedActions = deniedActionsFromDiagnostics(stderrText);
      const denied = hasDeniedEvidence || deniedActions.length > 0 || classifyDiagnostics(stderrText || undefined);
      const noticeText = notice ?? (deniedActions.length > 0 ? formatPermissionDenialNotice({ deniedTools, deniedActions }) : undefined);
      if (status !== "SUCCESS") {
        if (denied) {
          rejectWith(
            reject,
            new AgyRunnerError(
              "permission_denied",
              `ESCALATION REQUIRED: Agy ended the run with status ${String(status ?? "<missing>")} after a headless permission denial (not a user cancel).${noticeText ? `\n${noticeText}` : ""}`,
              {
                diagnostics: stderrText,
                status: String(status ?? ""),
                exitCode: code,
                conversationId,
                deniedTools: deniedTools.length > 0 ? [...deniedTools] : undefined,
                deniedActions: deniedActions.length > 0 ? [...deniedActions] : undefined,
              },
            ),
          );
          return;
        }
        rejectWith(reject, new AgyRunnerError("agy_status", `Agy finished with status ${String(status ?? "<missing>")}${result.error ? `: ${result.error}` : ""}`, { diagnostics: stderrText, status: String(status ?? ""), exitCode: code }));
        return;
      }
      if (code !== 0) {
        rejectWith(reject, new AgyRunnerError("nonzero_exit", `Agy returned non-zero exit code ${String(code)} despite SUCCESS status`, { diagnostics: stderrText, status: String(status), exitCode: code }));
        return;
      }
      if (typeof result.response !== "string") {
        rejectWith(reject, new AgyRunnerError("protocol_error", "Agy SUCCESS result is missing a string response", { diagnostics: stderrText, exitCode: code }));
        return;
      }
      settled = true;
      cleanup();
      const combinedDiagnostics = noticeText ? (stderrText ? `${noticeText}\n\n${stderrText}` : noticeText) : stderrText;
      const diagnosticText = combinedDiagnostics ? boundPiOutput(combinedDiagnostics) : undefined;
      resolvePromise({
        role: options.role,
        cwd: options.cwd,
        status: status as AgyStatus,
        response: boundPiOutput(result.response),
        conversationId,
        usage: result.usage ?? lastUsage,
        durationMs: Math.max(0, Math.round((result.duration_seconds ?? 0) * 1_000) || Date.now() - startedAt),
        numTurns: result.num_turns,
        diagnostics: diagnosticText,
        escalationRequired: denied,
        deniedTools: deniedTools.length > 0 ? deniedTools : undefined,
        deniedActions: deniedActions.length > 0 ? deniedActions : undefined,
        structuredOutput: result.structured_output,
      });
    });

    const inputMessage = `${JSON.stringify({
      event: "user",
      message: { content: buildAgyPrompt(options.task, options.cwd, options.context, options.files, { allowedCommands: options.allowedCommands, roleLimits: options.roleLimits }) },
    })}\n`;
    if (!proc.stdin) {
      pendingFailure = new AgyRunnerError("spawn_error", "Agy stream input is unavailable");
      terminate();
    } else {
      try {
        proc.stdin.end(inputMessage);
      } catch (error) {
        pendingFailure = new AgyRunnerError("spawn_error", `Unable to send task to agy: ${error instanceof Error ? error.message : String(error)}`);
        terminate();
      }
    }

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      terminationReason = "timeout";
      terminate();
    }, timeoutMs);
  });
}

function terminateProcessTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (platform === "win32" && child.pid) {
    const killer = nodeSpawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const directKill = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort; the parent timeout still settles the call.
      }
    };
    killer.once("error", directKill);
    killer.once("close", directKill);
    return;
  }
  child.kill("SIGTERM");
}
