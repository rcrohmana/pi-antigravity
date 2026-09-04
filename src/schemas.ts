export const MAX_PI_OUTPUT_BYTES = 50 * 1024;
export const MAX_PI_OUTPUT_LINES = 2_000;
export const OUTPUT_TRUNCATION_MARKER = "[output truncated: exceeded 50 KiB or 2000 lines]";

export function boundPiOutput(value: string, requiredNotice?: string): string {
  const text = String(value);
  const combined = requiredNotice ? `${text.trimEnd()}\n\n${requiredNotice}` : text;
  if (Buffer.byteLength(combined, "utf8") <= MAX_PI_OUTPUT_BYTES && lineCount(combined) <= MAX_PI_OUTPUT_LINES) return combined;

  const notice = requiredNotice
    ? takeHeadTail(requiredNotice, MAX_PI_OUTPUT_BYTES - Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8") - 1, MAX_PI_OUTPUT_LINES - 1)
    : "";
  const suffix = notice ? `${OUTPUT_TRUNCATION_MARKER}\n${notice}` : OUTPUT_TRUNCATION_MARKER;
  const suffixLines = lineCount(suffix);
  const head = takeHead(
    text,
    Math.max(0, MAX_PI_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8") - 1),
    Math.max(0, MAX_PI_OUTPUT_LINES - suffixLines - 1),
  );
  return head ? `${head}\n${suffix}` : suffix;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function takeHeadTail(value: string, maxBytes: number, maxLines: number): string {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes && lineCount(value) <= maxLines) return value;
  const marker = "[notice truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes <= markerBytes + 2 || maxLines <= 2) return takeHead(value, maxBytes, maxLines);
  const payloadBytes = maxBytes - markerBytes - 2;
  const payloadLines = maxLines - 2;
  const head = takeHead(value, Math.ceil(payloadBytes / 2), Math.ceil(payloadLines / 2));
  const tail = takeTail(value, Math.floor(payloadBytes / 2), Math.floor(payloadLines / 2));
  return [head, marker, tail].filter(Boolean).join("\n");
}

function takeHead(value: string, maxBytes: number, maxLines: number): string {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  const lines = value.split("\n").slice(0, maxLines);
  let result = lines.join("\n");
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    const chars = Array.from(result);
    let bytes = Buffer.byteLength(result, "utf8");
    while (chars.length && bytes > maxBytes) {
      bytes -= Buffer.byteLength(chars.pop()!, "utf8");
    }
    result = chars.join("");
  }
  return result;
}

function takeTail(value: string, maxBytes: number, maxLines: number): string {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  const lines = value.split("\n").slice(-maxLines);
  let result = lines.join("\n");
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    const chars = Array.from(result);
    const kept: string[] = [];
    let bytes = 0;
    for (let index = chars.length - 1; index >= 0; index -= 1) {
      const charBytes = Buffer.byteLength(chars[index], "utf8");
      if (bytes + charBytes > maxBytes) break;
      kept.push(chars[index]);
      bytes += charBytes;
    }
    result = kept.reverse().join("");
  }
  return result;
}

export const MAX_COMMAND_ARGS_CHARS = 8_000;

/** UTF-8-safe linear bound for slash-command arguments; returns the head plus a truncation notice. */
export function boundCommandArgs(args: string): string {
  const text = String(args);
  if (Buffer.byteLength(text, "utf8") <= MAX_COMMAND_ARGS_CHARS) return text;
  const marker = "[arguments truncated at 8000 characters]";
  const chars = Array.from(text);
  let bytes = Buffer.byteLength(text, "utf8");
  while (chars.length && bytes + Buffer.byteLength(marker, "utf8") + 1 > MAX_COMMAND_ARGS_CHARS) {
    bytes -= Buffer.byteLength(chars.pop()!, "utf8");
  }
  return `${chars.join("")}\n${marker}`;
}

export const AGY_STATUSES = [
  "SUCCESS",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
  "WAITING",
  "RUNNING",
] as const;

export type AgyStatus = (typeof AGY_STATUSES)[number];

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface AgyInitPayload {
  conversation_id?: string;
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
  json_schema?: unknown;
  [key: string]: unknown;
}

export interface AgyStepUpdatePayload {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  tool_info?:
    | { name?: string; parameters?: Record<string, unknown>; error?: { type?: string; message?: string; [k: string]: unknown }; [k: string]: unknown }
    | unknown;
  subagent_info?: unknown;
  [key: string]: unknown;
}

export interface AgyResultPayload {
  conversation_id?: string;
  status?: AgyStatus | string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
  structured_output?: unknown;
  json_schema?: unknown;
  denied_actions?: Array<{ action?: string; display_name?: string; [k: string]: unknown }>;
  [key: string]: unknown;
}

export interface AgyInitEvent {
  event: "init";
  init: AgyInitPayload;
  conversation_id?: string;
  [key: string]: unknown;
}

export interface AgyStepUpdateEvent {
  event: "step_update";
  step_update: AgyStepUpdatePayload;
  [key: string]: unknown;
}

export interface AgyResultEvent {
  event: "result";
  result: AgyResultPayload;
  [key: string]: unknown;
}

export type AgyStreamEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

/** One headlessly auto-denied tool call, distilled into an actionable summary. */
/** One entry of the terminal result's `denied_actions` (permission category, not a specific call). */
export interface AgyDeniedAction {
  action?: string;
  displayName?: string;
}

export interface AgyDeniedTool {
  toolName: string;
  summary: string;
  message?: string;
  suggestedRule?: string;
}

/**
 * Recorded when the extension continued the same Agy conversation once after a
 * headless permission denial (item 4 auto-retry). The first attempt's denial
 * evidence is preserved so the owner can still add the right allow rule.
 */
export interface AgyRetryInfo {
  attempted: true;
  firstAttemptStatus: string;
  firstAttemptDeniedTools: AgyDeniedTool[];
  firstAttemptDeniedActions: AgyDeniedAction[];
  firstAttemptNotice?: string;
}

export interface AgyToolDetails {
  role: string;
  cwd: string;
  status: AgyStatus;
  response?: string;
  conversationId?: string;
  usage?: AgyUsage;
  durationMs?: number;
  numTurns?: number;
  diagnostics?: string;
  structuredOutput?: unknown;
  partial?: boolean;
  stepType?: string;
  error?: string;
  escalationRequired?: boolean;
  retry?: AgyRetryInfo;
  deniedTools?: AgyDeniedTool[];
  deniedActions?: AgyDeniedAction[];
  /** Present only on a synthetic "research_apply" role: the per-leg details of the composite flow. */
  legs?: { research?: AgyToolDetails; apply?: AgyToolDetails };
}

export interface AgyRunSummary {
  role: string;
  cwd: string;
  status: AgyStatus;
  response: string;
  conversationId?: string;
  usage?: AgyUsage;
  durationMs: number;
  numTurns?: number;
  diagnostics?: string;
  structuredOutput?: unknown;
  escalationRequired?: boolean;
  retry?: AgyRetryInfo;
  deniedTools?: AgyDeniedTool[];
  deniedActions?: AgyDeniedAction[];
}

export type AgyErrorCode =
  | "executable_not_found"
  | "spawn_error"
  | "protocol_error"
  | "missing_result"
  | "agy_status"
  | "nonzero_exit"
  | "timeout"
  | "aborted"
  | "permission_denied";

export class AgyRunnerError extends Error {
  readonly code: AgyErrorCode;
  readonly diagnostics?: string;
  readonly status?: string;
  readonly exitCode?: number | null;
  /** Agy conversation ID when the stream reported one before the failure (enables a bounded continuation). */
  readonly conversationId?: string;
  /** Denied tool calls observed before the failure (bounded summaries only). */
  readonly deniedTools?: AgyDeniedTool[];
  /** Permission categories the terminal result reported as denied. */
  readonly deniedActions?: AgyDeniedAction[];

  constructor(
    code: AgyErrorCode,
    message: string,
    details: { diagnostics?: string; status?: string; exitCode?: number | null; conversationId?: string; deniedTools?: AgyDeniedTool[]; deniedActions?: AgyDeniedAction[] } = {},
  ) {
    const diagnostics = details.diagnostics ? boundPiOutput(details.diagnostics) : undefined;
    const requiredNotice = diagnostics ? `Diagnostics: ${diagnostics}` : undefined;
    super(boundPiOutput(diagnostics ? `${message}\n${requiredNotice}` : message, requiredNotice));
    this.name = "AgyRunnerError";
    this.code = code;
    this.diagnostics = diagnostics;
    this.status = details.status;
    this.exitCode = details.exitCode;
    this.conversationId = details.conversationId;
    this.deniedTools = details.deniedTools;
    this.deniedActions = details.deniedActions;
  }
}
