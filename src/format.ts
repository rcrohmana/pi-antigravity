// Pure, dependency-free formatting for what the user sees in Pi: the call
// line, the status-line progress text, and the result summary. Kept out of
// render.ts (which needs pi-tui at runtime) so it is type-checked and unit
// tested.
import { ROLE_CONFIGS, type AgyRole } from "./roles.ts";
import type { AgyToolDetails, AgyUsage } from "./schemas.ts";

/** Longest tool target or text tail shown in the status line. */
export const PROGRESS_DETAIL_CHARS = 80;
/** Characters of a conversation ID shown in summaries (enough to disambiguate, short enough to scan). */
export const SHORT_CONVERSATION_ID_CHARS = 8;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Human duration for summaries: 842ms, 12s, 1m 42s, 1h 02m. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Running clock for the status line: 0:07, 1:42, 1:02:03. */
export function formatClock(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const mmss = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : mmss;
}

function usageTotal(usage: AgyUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0) return usage.total_tokens;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const sum = (input ?? 0) + (output ?? 0);
  return Number.isFinite(sum) && sum >= 0 ? sum : undefined;
}

/** Token count for quota awareness: "532 tokens", "12.3k tokens", "1.25M tokens". */
export function formatTokens(usage: AgyUsage | undefined): string | undefined {
  const total = usageTotal(usage);
  if (total === undefined) return undefined;
  if (total < 1_000) return `${Math.round(total)} tokens`;
  if (total < 1_000_000) return `${(total / 1_000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `${(total / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M tokens`;
}

export function shortConversationId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.length > SHORT_CONVERSATION_ID_CHARS ? id.slice(0, SHORT_CONVERSATION_ID_CHARS) : id;
}

/** What the role can do, for the call line: "read-only", "writes", "research → writes". */
export function describeRoleCapability(role: string | undefined): string | undefined {
  if (!role) return undefined;
  if (Object.hasOwn(ROLE_CONFIGS, role)) return ROLE_CONFIGS[role as AgyRole].readOnly ? "read-only" : "writes";
  if (role === "research_apply") return "research → writes";
  if (role === "doctor") return "read-only";
  return undefined;
}

export interface ProgressInfo {
  role: string;
  elapsedMs?: number;
  stepIndex?: number;
  stepType?: string;
  toolName?: string;
  toolTarget?: string;
  textDelta?: string;
}

/**
 * Status-line text while Agy runs, e.g.
 * `worker · 1:42 · step 7 · run_command git status` or
 * `researcher · 0:12 · step 2 · agent_response: …tail of the text`.
 */
export function formatProgress(info: ProgressInfo): string {
  const parts: string[] = [info.role];
  const clock = formatClock(info.elapsedMs);
  if (clock) parts.push(clock);
  if (typeof info.stepIndex === "number" && Number.isFinite(info.stepIndex)) parts.push(`step ${info.stepIndex}`);
  if (info.toolName) {
    const target = info.toolTarget ? collapseWhitespace(info.toolTarget).slice(0, PROGRESS_DETAIL_CHARS) : "";
    parts.push(target ? `${info.toolName} ${target}` : info.toolName);
  } else if (info.textDelta) {
    parts.push(`${info.stepType ?? "text"}: ${collapseWhitespace(info.textDelta).slice(-PROGRESS_DETAIL_CHARS)}`);
  } else {
    parts.push(info.stepType ?? "working");
  }
  return parts.join(" · ");
}

/**
 * One-line result summary, e.g.
 * `✓ worker · 1m 42s · 5 turns · 12.3k tokens · ↻ retried once · conv a0ecb8ba`.
 */
export function formatResultSummary(details: Partial<AgyToolDetails> | undefined): string {
  const role = details?.role ?? "agy";
  const parts: string[] = [`${details?.escalationRequired ? "⚠" : "✓"} ${role}`];
  const duration = formatDuration(details?.durationMs);
  if (duration) parts.push(duration);
  if (typeof details?.numTurns === "number" && Number.isFinite(details.numTurns)) {
    parts.push(`${details.numTurns} turn${details.numTurns === 1 ? "" : "s"}`);
  }
  const tokens = formatTokens(details?.usage);
  if (tokens) parts.push(tokens);
  if (details?.retry?.attempted) parts.push("↻ retried once");
  const conversation = shortConversationId(details?.conversationId);
  if (conversation) parts.push(`conv ${conversation}`);
  return parts.join(" · ");
}

/** Per-leg summary for the composite tool: `research ✓ 2m 10s · apply ✓ 48s`. */
function formatLegSummaries(legs: NonNullable<AgyToolDetails["legs"]>): { parts: string[]; totalMs: number | undefined; totalTokens: number | undefined } {
  const parts: string[] = [];
  let totalMs: number | undefined;
  let totalTokens: number | undefined;
  for (const [label, leg] of [["research", legs.research], ["apply", legs.apply]] as const) {
    if (!leg) continue;
    const mark = leg.error || (leg.status && leg.status !== "SUCCESS") ? "✗" : leg.escalationRequired ? "⚠" : "✓";
    const duration = formatDuration(leg.durationMs);
    parts.push(`${label} ${mark}${duration ? ` ${duration}` : ""}`);
    if (typeof leg.durationMs === "number" && Number.isFinite(leg.durationMs)) totalMs = (totalMs ?? 0) + leg.durationMs;
    const tokens = usageTotal(leg.usage);
    if (tokens !== undefined) totalTokens = (totalTokens ?? 0) + tokens;
  }
  return { parts, totalMs, totalTokens };
}

/**
 * Result summary for `agy_research_apply`:
 * `✓ research_apply · 2m 58s · research ✓ 2m 10s · apply ✓ 48s · 15.2k tokens · conv a0ecb8ba`.
 */
export function formatCompositeResultSummary(details: Partial<AgyToolDetails>): string {
  const legs = details.legs;
  if (!legs) return formatResultSummary(details);
  const { parts: legParts, totalMs, totalTokens } = formatLegSummaries(legs);
  const parts: string[] = [`${details.escalationRequired ? "⚠" : "✓"} ${details.role ?? "research_apply"}`];
  const total = formatDuration(totalMs);
  if (total) parts.push(total);
  parts.push(...legParts);
  const tokens = formatTokens(totalTokens === undefined ? undefined : { total_tokens: totalTokens });
  if (tokens) parts.push(tokens);
  if (details.retry?.attempted || legs.research?.retry?.attempted || legs.apply?.retry?.attempted) parts.push("↻ retried once");
  const conversation = shortConversationId(details.conversationId);
  if (conversation) parts.push(`conv ${conversation}`);
  return parts.join(" · ");
}

/** Agy settings file the owner edits, per platform. */
export function agySettingsPathHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "%USERPROFILE%\\.gemini\\antigravity-cli\\settings.json" : "~/.gemini/antigravity-cli/settings.json";
}

/**
 * Copy-ready lines for a headless denial: the exact allow rules to paste and
 * what to do next. Rendered first so they are visible even in a collapsed
 * tool result.
 */
export function formatDenialActions(input: {
  suggestedRules: readonly string[];
  conversationId?: string;
  platform?: NodeJS.Platform;
}): string {
  const rules = [...new Set(input.suggestedRules.filter((rule) => rule.trim()))];
  const lines: string[] = [];
  if (rules.length > 0) {
    lines.push(`Add to permissions.allow in ${agySettingsPathHint(input.platform)}:`);
    for (const rule of rules) lines.push(`  ${JSON.stringify(rule)}`);
  } else {
    lines.push(`Add a matching allow rule to permissions.allow in ${agySettingsPathHint(input.platform)} (see the denial details below).`);
  }
  const next = ["Next: run /agy_doctor to verify the rules"];
  if (input.conversationId) next.push(`then continue this run with conversation_id ${JSON.stringify(input.conversationId)}`);
  lines.push(`${next.join(", ")}.`);
  return lines.join("\n");
}

/** Message for a timeout or cancellation, with elapsed time and how to resume (item 9). */
export function formatTerminationMessage(input: {
  reason: "timeout" | "aborted";
  elapsedMs?: number;
  timeoutMs?: number;
  conversationId?: string;
}): string {
  const elapsed = formatDuration(input.elapsedMs);
  const head =
    input.reason === "timeout"
      ? `Agy delegation exceeded ${input.timeoutMs !== undefined ? `${input.timeoutMs}ms (${formatDuration(input.timeoutMs) ?? ""})` : "its deadline"}; the Agy process was terminated.`
      : `Agy delegation was canceled${elapsed ? ` after ${elapsed}` : ""}; the Agy process was terminated.`;
  const resume = input.conversationId
    ? `Work so far is kept in Agy conversation ${shortConversationId(input.conversationId)}; continue it with conversation_id ${JSON.stringify(input.conversationId)}.`
    : "No Agy conversation id was received before it stopped, so the run cannot be resumed; start it again.";
  return `${head} ${resume}`;
}

/** One-line positive readiness notice shown once per workspace per session (item 8). */
export function formatReadyNotice(input: {
  cwd: string;
  readRule?: string;
  writeRule?: string;
  readOnlyRole: boolean;
  commandCount?: number;
}): string {
  const rules = [input.readRule ? `${input.readRule} (read)` : undefined, !input.readOnlyRole && input.writeRule ? `${input.writeRule} (write)` : undefined].filter(
    (rule): rule is string => Boolean(rule),
  );
  const parts = [`✓ Agy ready for ${input.cwd}: ${rules.join(" and ")} cover this workspace`];
  if (!input.readOnlyRole) {
    if (!input.writeRule) parts.push("no write_file rule (writes will be auto-denied)");
    if (typeof input.commandCount === "number") parts.push(input.commandCount === 0 ? "no commands allowed" : `${input.commandCount} command${input.commandCount === 1 ? "" : "s"} allowed`);
  }
  return parts.join("; ");
}

function slashed(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Show a tool target relative to the workspace when it lies inside it
 * (`script/vsh.py` instead of `C:\\Users\\...\\playground\\script\\vsh.py`);
 * targets outside the workspace stay absolute so they are noticed.
 * Case-insensitive on Windows, where Agy may echo a different drive-letter case.
 */
export function relativizeTarget(target: string | undefined, cwd: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!target || !cwd) return target;
  const normalizedCwd = slashed(cwd).replace(/\/+$/, "");
  const normalizedTarget = slashed(target);
  const fold = (value: string): string => (platform === "win32" ? value.toLowerCase() : value);
  if (fold(normalizedTarget) === fold(normalizedCwd)) return ".";
  const prefix = `${normalizedCwd}/`;
  if (fold(normalizedTarget).startsWith(fold(prefix))) return normalizedTarget.slice(prefix.length) || ".";
  return target;
}
