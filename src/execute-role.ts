// The role-tool execution path: validation, preflight, the Pi write gate,
// the researcher-context gate, command policy, the bounded auto-retry runner,
// progress forwarding, and notice assembly. It lives outside index.ts so it
// can be exercised end-to-end by tests with a fake Pi context and injected
// runner/settings/preflight functions (A-07); index.ts only wires it to the
// pi tool registration.
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { loadAllowedCommands } from "./agy-settings.ts";
import { preflightCwdCoverage } from "./doctor.ts";
import {
  authorizeResearchContext,
  authorizeWriteRole,
  validateContext,
  validateConversationId,
  validateCwd,
  validateFileHints,
  validateTask,
} from "./policy.ts";
import { formatProgress, formatReadyNotice } from "./format.ts";
import { runAgyWithDenialRetry } from "./retry.ts";
import { ROLE_CONFIGS, type AgyRole } from "./roles.ts";
import { formatModelVisibleResponse } from "./runner.ts";
import type { AgyToolDetails } from "./schemas.ts";

export const roleParameters = Type.Object({
  task: Type.String({ description: "A bounded task for the selected Agy role", minLength: 1, maxLength: 20_000 }),
  context: Type.Optional(Type.String({ description: "Explicit parent context only; never the full Pi conversation", maxLength: 30_000 })),
  files: Type.Optional(Type.Array(Type.String({ description: "Explicit file path hint", maxLength: 1_000 }), { maxItems: 100 })),
  cwd: Type.Optional(Type.String({ description: "Workspace directory, limited to the current Pi workspace or its descendants" })),
  timeout_ms: Type.Optional(Type.Integer({ description: "Parent-side deadline in milliseconds", minimum: 1_000, maximum: 1_800_000, default: 300_000 })),
  conversation_id: Type.Optional(Type.String({ description: "Agy conversation ID for explicit continuation", maxLength: 256 })),
  auto_retry: Type.Optional(
    Type.Boolean({
      description: "Default true: after a headless permission denial that produced no output, continue the same Agy conversation once with an instruction not to repeat the denied call",
      default: true,
    }),
  ),
  skip_preflight: Type.Optional(
    Type.Boolean({
      description: "Default false: skip the no-spawn preflight that refuses local-file roles when Agy settings have no read_file(...) allow rule covering cwd (use only when rules come from a source the preflight cannot see)",
      default: false,
    }),
  ),
});

export type RoleParameters = Static<typeof roleParameters>;
export type RoleToolUpdate = AgentToolResult<AgyToolDetails>;
export type RoleToolResult = { content: Array<{ type: "text"; text: string }>; details: AgyToolDetails };

/** Pi status-line key used for every role. */
export const STATUS_KEY = "pi-antigravity";

/** Text-only deltas update the status line at most this often; tool and step changes always do. */
export const PROGRESS_THROTTLE_MS = 250;

/** Workspaces already announced as ready in this Pi process (item 8: one positive notice per session). */
const announcedReadyCwds = new Set<string>();

/** Test seam: forget which workspaces were announced. */
export function resetReadyAnnouncements(): void {
  announcedReadyCwds.clear();
}

/** Seams for tests; production callers pass nothing and get the real modules. */
export interface ExecuteRoleDeps {
  runRole?: typeof runAgyWithDenialRetry;
  loadAllowedCommands?: typeof loadAllowedCommands;
  preflightCwdCoverage?: typeof preflightCwdCoverage;
  /** Clock for the elapsed time and throttle; defaults to Date.now. */
  now?: () => number;
}

/** Caller-only options: the composite tool's one-gate seam and its phase label for progress. */
export interface ExecuteRoleInternal {
  skipWriteGate?: boolean;
  /** Replaces the bare role name in progress text, e.g. "1/2 researcher". */
  progressLabel?: string;
}

export async function executeRole(
  role: AgyRole,
  params: RoleParameters,
  signal: AbortSignal | undefined,
  onUpdate: ((update: RoleToolUpdate) => void) | undefined,
  ctx: ExtensionContext,
  internal: ExecuteRoleInternal = {},
  deps: ExecuteRoleDeps = {},
): Promise<RoleToolResult> {
  const runRole = deps.runRole ?? runAgyWithDenialRetry;
  const loadCommands = deps.loadAllowedCommands ?? loadAllowedCommands;
  const preflight = deps.preflightCwdCoverage ?? preflightCwdCoverage;
  const now = deps.now ?? Date.now;

  const task = validateTask(params.task);
  const context = validateContext(params.context);
  const conversationId = validateConversationId(params.conversation_id);
  const cwd = await validateCwd(params.cwd, ctx.cwd, [ctx.cwd]);
  const files = validateFileHints(params.files, cwd);
  if (role === "researcher" && files?.length) {
    throw new Error("agy_researcher does not accept file hints because it has no local-file tools");
  }
  // Preflight (item 6): headless Agy auto-denies every local file tool unless a
  // read_file(...) allow rule covers the path, so a local-file role without
  // coverage would only burn quota. Refuse before any confirmation or spawn.
  // Advisory only when settings are unreadable; skip_preflight is the escape
  // hatch for rules the parent cannot see (shared config, project grants).
  let preflightNotice: string | undefined;
  let writeCoverage: "covered" | "uncovered" | "unknown" | undefined;
  let readyNotice: string | undefined;
  // Write-capable roles get the owner's Agy command allow-rule targets as
  // advisory prompt text so the model does not probe with commands headless
  // Agy would auto-deny (e.g. `python --version`); read-only roles never
  // call run_command, so no policy is loaded or sent for them. Loaded before
  // the gate so the confirmation can show what the role will be allowed to run.
  const commandPolicy = ROLE_CONFIGS[role].readOnly ? undefined : await loadCommands();
  if (role !== "researcher" && !conversationId && !params.skip_preflight) {
    const coverage = await preflight({ cwd });
    if (coverage.source === "settings") writeCoverage = coverage.writeCoveringRule ? "covered" : "uncovered";
    else writeCoverage = "unknown";
    if (coverage.source === "settings" && coverage.readCoveringRule && !announcedReadyCwds.has(cwd)) {
      readyNotice = formatReadyNotice({
        cwd,
        readRule: coverage.readCoveringRule,
        writeRule: coverage.writeCoveringRule,
        readOnlyRole: ROLE_CONFIGS[role].readOnly,
        commandCount: commandPolicy?.source === "settings" ? commandPolicy.commands.length : undefined,
      });
    }
    if (coverage.source === "settings" && !coverage.readCoveringRule) {
      throw new Error(
        `Agy preflight: no read_file(...) allow rule in Agy settings covers ${cwd}; headless Agy would auto-deny every local file tool for ${role}. ` +
          `Add read_file(${cwd.replace(/\\/g, "/")}) (and write_file(...) for worker/delegate) to permissions.allow, run /agy_doctor for the full report, or pass skip_preflight: true if the rule comes from a source the preflight cannot read.`,
      );
    }
    if (coverage.source === "unavailable") {
      preflightNotice = `[Agy preflight] Agy settings unavailable (${coverage.reason ?? "unknown"}); cwd coverage was not checked.`;
    } else if (!ROLE_CONFIGS[role].readOnly && !coverage.writeCoveringRule) {
      preflightNotice = `[Agy preflight] No write_file(...) allow rule covers ${cwd}; ${role} can read but every write will be auto-denied.`;
    }
  }
  // skipWriteGate is only set by composite tools that already showed one
  // combined confirmation for this same role in this same call; it never
  // bypasses the headless denial (hasUI is still required by the composite gate).
  if (!(internal.skipWriteGate && ctx.hasUI)) {
    const gate = await authorizeWriteRole(role, { cwd, task, context, files, allowedCommands: commandPolicy?.source === "settings" ? commandPolicy.commands : undefined, writeCoverage }, {
      hasUI: ctx.hasUI,
      confirm: ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : undefined,
    });
    if (!gate.allowed) throw new Error(gate.reason ?? "Agy delegation denied by policy");
  }
  if (role === "researcher" && context) {
    const researchGate = await authorizeResearchContext({ cwd, task, context }, {
      hasUI: ctx.hasUI,
      confirm: ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : undefined,
    });
    if (!researchGate.allowed) throw new Error(researchGate.reason ?? "Agy researcher context delegation denied by policy");
  }

  // The positive readiness line is shown once per workspace per session,
  // only after the gates passed (so a declined confirmation shows nothing).
  if (readyNotice && ctx.hasUI) {
    announcedReadyCwds.add(cwd);
    ctx.ui.notify(readyNotice, "info");
  }

  const progressLabel = internal.progressLabel ?? role;
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `${progressLabel} · starting`);
  const startedAt = now();
  let lastTextUpdateAt = Number.NEGATIVE_INFINITY;
  try {
    const run = await runRole({
      autoRetry: params.auto_retry !== false,
      role,
      task,
      cwd,
      context,
      files,
      timeoutMs: params.timeout_ms,
      conversationId,
      model: ROLE_CONFIGS[role].model,
      mode: ROLE_CONFIGS[role].mode,
      allowedCommands: commandPolicy?.commands,
      roleLimits: ROLE_CONFIGS[role].degradation,
      signal,
      onProgress: (progress) => {
        const at = now();
        // Streams of text deltas would otherwise redraw the status line on
        // every chunk; tool calls and step changes are always shown.
        const textOnly = Boolean(progress.textDelta) && !progress.toolName;
        if (textOnly) {
          if (at - lastTextUpdateAt < PROGRESS_THROTTLE_MS) return;
          lastTextUpdateAt = at;
        }
        const text = formatProgress({
          role: progressLabel,
          elapsedMs: at - startedAt,
          stepIndex: progress.stepIndex,
          stepType: progress.stepType,
          toolName: progress.toolName,
          toolTarget: progress.toolTarget,
          textDelta: progress.textDelta,
        });
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { role, cwd, status: "RUNNING", partial: true, stepType: progress.stepType },
        });
      },
    });
    const notices = [
      preflightNotice,
      commandPolicy?.source === "unavailable"
        ? `[Agy settings notice] Command allow rules unavailable (${commandPolicy.reason ?? "unknown"}); worker was told to run no commands.`
        : undefined,
    ].filter((line): line is string => Boolean(line));
    const responseText = notices.length ? `${notices.join("\n")}\n\n${formatModelVisibleResponse(run)}` : formatModelVisibleResponse(run);
    return {
      content: [{ type: "text", text: responseText }],
      details: run,
    };
  } finally {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
