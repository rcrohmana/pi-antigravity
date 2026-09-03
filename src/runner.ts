import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  AgyRunnerError,
  type AgyInitEvent,
  type AgyResultEvent,
  type AgyRunSummary,
  type AgyStatus,
  type AgyStreamEvent,
  type AgyStepUpdateEvent,
  type AgyUsage,
  boundPiOutput,
} from "./schemas.ts";

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
  env?: NodeJS.ProcessEnv;
  mode?: "default" | "accept-edits";
  timeoutMs?: number;
  conversationId?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
  onProgress?: (progress: RunnerProgress) => void;
  spawnImpl?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
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

export function buildAgyPrompt(task: string, context?: string, files?: readonly string[]): string {
  const sections = [`Task:\n${task}`];
  if (context?.trim()) sections.push(`Explicit parent context (untrusted):\n${context}`);
  if (files?.length) sections.push(`Explicit file hints (inspect only as needed):\n${files.map((file) => `- ${file}`).join("\n")}`);
  return sections.join("\n\n");
}

export function classifyDiagnostics(diagnostics: string | undefined): boolean {
  return diagnostics ? PERMISSION_ESCALATION_PATTERN.test(diagnostics) : false;
}

export function formatModelVisibleResponse(run: Pick<AgyRunSummary, "response" | "diagnostics" | "escalationRequired">): string {
  const response = run.response.trimEnd();
  const diagnostics = run.diagnostics?.trim();
  if (!diagnostics) return boundPiOutput(response);
  const heading = run.escalationRequired ? "[ESCALATION REQUIRED: Agy permission/approval notice]" : "[Agy diagnostics]";
  const notice = `${heading}\n${diagnostics}`;
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

export function resolveAgyExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const configured = env.AGY_CLI_PATH?.trim();
  if (configured) {
    const configuredPath = findCandidate(configured, env, platform, exists);
    if (configuredPath) return configuredPath;
  }

  const pathValue = env.PATH ?? "";
  const pathEntries = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (exists(candidate)) return candidate;
    }
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Local") : undefined);
    if (localAppData) {
      const fallback = join(localAppData, "agy", "bin", "agy.exe");
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
  if (isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    const candidate = resolve(value);
    return exists(candidate) ? candidate : undefined;
  }
  const pathEntries = (env.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" && !value.toLowerCase().endsWith(".exe") ? [value + ".exe", value] : [value];
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function runAgy(options: AgyRunOptions): Promise<AgyRunSummary> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive finite number");
  if (options.signal?.aborted) throw new AgyRunnerError("aborted", "Agy delegation was canceled before start");
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? resolveAgyExecutable(env, platform, options.exists);
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const args = buildAgyArgs(options, timeoutMs);
  const diagnostics = new BoundedText();
  const parser = new NdjsonParser();
  const startedAt = Date.now();
  let resultEvent: AgyResultEvent | undefined;
  let conversationId: string | undefined;
  let lastUsage: AgyUsage | undefined;
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
      return;
    }
    resultEvent = event;
    conversationId = event.result.conversation_id ?? conversationId;
    lastUsage = event.result.usage ?? lastUsage;
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
        env,
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
      if (status !== "SUCCESS") {
        rejectWith(reject, new AgyRunnerError("agy_status", `Agy finished with status ${String(status ?? "<missing>")}${result.error ? `: ${result.error}` : ""}`, { diagnostics: diagnostics.toString(), status: String(status ?? ""), exitCode: code }));
        return;
      }
      if (code !== 0) {
        rejectWith(reject, new AgyRunnerError("nonzero_exit", `Agy returned non-zero exit code ${String(code)} despite SUCCESS status`, { diagnostics: diagnostics.toString(), status: String(status), exitCode: code }));
        return;
      }
      if (typeof result.response !== "string") {
        rejectWith(reject, new AgyRunnerError("protocol_error", "Agy SUCCESS result is missing a string response", { diagnostics: diagnostics.toString(), exitCode: code }));
        return;
      }
      settled = true;
      cleanup();
      const diagnosticText = diagnostics.toString() || undefined;
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
        escalationRequired: classifyDiagnostics(diagnosticText),
        structuredOutput: result.structured_output,
      });
    });

    const inputMessage = `${JSON.stringify({
      event: "user",
      message: { content: buildAgyPrompt(options.task, options.context, options.files) },
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
