import { AgyRunnerError, type AgyDeniedAction, type AgyDeniedTool, type AgyRetryInfo, type AgyRunSummary } from "./schemas.ts";
import { formatPermissionDenialNotice, runAgy, type AgyRunOptions } from "./runner.ts";

/**
 * Bounded auto-retry after a headless permission denial (item 4).
 *
 * Headless Agy cannot prompt, so a tool call outside the owner's allow rules is
 * auto-denied and usually ends the run with no output. Instead of surfacing
 * that as a dead end, the extension continues the SAME Agy conversation exactly
 * once with a short policy notice telling the model which call was denied and
 * that it must finish without it (or return an explicit escalation). The
 * boundary does not move: the retry never adds permissions, never changes the
 * role, and the first attempt's denial evidence is preserved on the result so
 * the owner can still add the right allow rule.
 */

export const MAX_DENIAL_RETRIES = 1;

export interface DenialRetryOptions extends AgyRunOptions {
  /** Default true. Set false to disable the single continuation. */
  autoRetry?: boolean;
  /** Test hook. Defaults to runAgy. */
  runImpl?: (options: AgyRunOptions) => Promise<AgyRunSummary>;
}

interface FirstAttempt {
  status: string;
  conversationId?: string;
  deniedTools: AgyDeniedTool[];
  deniedActions: AgyDeniedAction[];
  notice?: string;
  /** Substantive model text from the first attempt, if any. */
  response: string;
}

function firstAttemptFromSummary(run: AgyRunSummary): FirstAttempt {
  return {
    status: run.status,
    conversationId: run.conversationId,
    deniedTools: run.deniedTools ?? [],
    deniedActions: run.deniedActions ?? [],
    notice: run.deniedTools?.length || run.deniedActions?.length ? formatPermissionDenialNotice({ deniedTools: run.deniedTools ?? [], deniedActions: run.deniedActions }) : undefined,
    response: run.response,
  };
}

function firstAttemptFromError(error: AgyRunnerError): FirstAttempt {
  return {
    status: error.status || "ERROR",
    conversationId: error.conversationId,
    deniedTools: error.deniedTools ?? [],
    deniedActions: error.deniedActions ?? [],
    notice: error.deniedTools?.length || error.deniedActions?.length ? formatPermissionDenialNotice({ deniedTools: error.deniedTools ?? [], deniedActions: error.deniedActions }) : undefined,
    response: "",
  };
}

/**
 * A retry is worth one more model turn only when the first attempt produced
 * nothing usable because of a denial and the conversation can be resumed.
 * A run that was denied but still returned substantive text already worked
 * around the denial and is returned as-is.
 */
export function shouldRetryAfterDenial(attempt: { escalationRequired?: boolean; deniedTools?: readonly AgyDeniedTool[]; response: string; conversationId?: string }): boolean {
  if (!attempt.conversationId) return false;
  if (!attempt.escalationRequired) return false;
  if (attempt.response.trim() !== "") return false;
  return true;
}

/** Human wording for a denied permission category when no per-call detail was streamed. */
const ACTION_HINTS: Record<string, string> = {
  command: "run_command (any shell command)",
  read_file: "local file reads outside the allowed roots",
  write_file: "local file writes outside the allowed roots",
  read_url: "fetching that URL",
};

/** Follow-up user turn sent into the resumed conversation. Names only bounded denial summaries. */
export function buildDenialFollowUpTask(deniedTools: readonly AgyDeniedTool[], deniedActions: readonly AgyDeniedAction[] = []): string {
  const lines = [
    "Policy notice from the parent orchestrator: the following tool call(s) were auto-denied by Agy permission rules in this headless session and will be denied again if repeated:",
  ];
  if (deniedTools.length) {
    for (const tool of deniedTools) lines.push(`- ${tool.toolName} \`${tool.summary}\``);
  } else if (deniedActions.length) {
    for (const action of deniedActions) {
      const name = action.action ?? "unknown";
      lines.push(`- the "${name}" permission${action.displayName ? ` (${action.displayName})` : ""}: ${ACTION_HINTS[name] ?? "that category of tool call"}`);
    }
  } else {
    lines.push("- (the exact call was not reported; treat any command, file, or URL access that failed as denied)");
  }
  lines.push(
    "Do not call them again and do not try equivalent variants.",
    "Complete the rest of the original task without them. Where a part of the task is impossible without the denied call, do not guess: finish everything else, then list exactly what was skipped under \"Decisions needed\" together with the allow rule the owner would need.",
  );
  return lines.join("\n");
}

function attachRetry(run: AgyRunSummary, first: FirstAttempt): AgyRunSummary {
  const retry: AgyRetryInfo = {
    attempted: true,
    firstAttemptStatus: first.status,
    firstAttemptDeniedTools: first.deniedTools,
    firstAttemptDeniedActions: first.deniedActions,
    firstAttemptNotice: first.notice,
  };
  // Keep the first attempt's actionable notice visible even when the
  // continuation succeeded cleanly, so the owner can still fix the rule.
  const diagnostics = run.diagnostics ?? first.notice;
  return { ...run, retry, diagnostics, escalationRequired: run.escalationRequired || run.deniedTools !== undefined };
}

/**
 * Runs one Agy delegation and, on a headless denial that produced no output,
 * continues the same conversation once. Errors from the continuation are
 * rethrown with the first attempt's notice prepended so nothing is lost.
 */
export async function runAgyWithDenialRetry(options: DenialRetryOptions): Promise<AgyRunSummary> {
  const { autoRetry, runImpl, ...runOptions } = options;
  const run = runImpl ?? runAgy;
  let first: FirstAttempt | undefined;
  try {
    const result = await run(runOptions);
    if (autoRetry === false || !shouldRetryAfterDenial(result)) return result;
    first = firstAttemptFromSummary(result);
  } catch (error) {
    if (autoRetry === false || !(error instanceof AgyRunnerError) || error.code !== "permission_denied" || !error.conversationId) throw error;
    first = firstAttemptFromError(error);
  }

  const followUp: AgyRunOptions = {
    ...runOptions,
    task: buildDenialFollowUpTask(first.deniedTools, first.deniedActions),
    // The original context and file hints are already in the conversation.
    context: undefined,
    files: undefined,
    conversationId: first.conversationId,
  };
  try {
    const second = await run(followUp);
    return attachRetry(second, first);
  } catch (error) {
    if (error instanceof AgyRunnerError) {
      const prefix = first.notice ? `${first.notice}\n\n` : "";
      throw new AgyRunnerError(error.code, `${prefix}[Agy auto-retry] The continuation also failed: ${error.message}`, {
        diagnostics: error.diagnostics,
        status: error.status,
        exitCode: error.exitCode,
        conversationId: error.conversationId ?? first.conversationId,
        deniedTools: error.deniedTools ?? first.deniedTools,
        deniedActions: error.deniedActions ?? first.deniedActions,
      });
    }
    throw error;
  }
}
