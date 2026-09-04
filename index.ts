import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { formatProgress, renderAgyCall, renderAgyResult } from "./src/render.ts";
import { formatModelVisibleResponse } from "./src/runner.ts";
import { runAgyWithDenialRetry } from "./src/retry.ts";
import { preflightCwdCoverage, runAgyDoctor } from "./src/doctor.ts";
import { executeResearchApply, researchApplyParameters } from "./src/research-apply.ts";
import { loadAllowedCommands } from "./src/agy-settings.ts";
import { registerAgyCommands } from "./src/commands.ts";
import { ROLE_CHAINING_GUIDE, ROLE_CONFIGS, ROLES, type AgyRole } from "./src/roles.ts";
import {
  authorizeResearchContext,
  authorizeWriteRole,
  validateContext,
  validateConversationId,
  validateCwd,
  validateFileHints,
  validateTask,
} from "./src/policy.ts";
import type { AgyToolDetails } from "./src/schemas.ts";

const roleParameters = Type.Object({
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

const doctorParameters = Type.Object({
  cwd: Type.Optional(Type.String({ description: "Workspace directory to check, limited to the current Pi workspace or its descendants" })),
});
type DoctorParameters = Static<typeof doctorParameters>;
type RoleParameters = Static<typeof roleParameters>;

type ToolDetails = AgyToolDetails;
type ToolUpdate = AgentToolResult<ToolDetails>;

function toolDescription(role: AgyRole): string {
  const config = ROLE_CONFIGS[role];
  const write = config.readOnly ? "read-only" : "write-capable and requires confirmation";
  return `Delegate a bounded task to the official agy CLI using the ${role} role (${write}). ${config.summary} ${config.boundary} ${ROLE_CHAINING_GUIDE} Output is bounded; no full Pi conversation is forwarded.`;
}

async function executeRole(
  role: AgyRole,
  params: RoleParameters,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ToolUpdate) => void) | undefined,
  ctx: ExtensionContext,
  internal: { skipWriteGate?: boolean } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const task = validateTask(params.task);
  const context = validateContext(params.context);
  const files = validateFileHints(params.files);
  if (role === "researcher" && files?.length) {
    throw new Error("agy_researcher does not accept file hints because it has no local-file tools");
  }
  const conversationId = validateConversationId(params.conversation_id);
  const cwd = await validateCwd(params.cwd, ctx.cwd, [ctx.cwd]);
  // Preflight (item 6): headless Agy auto-denies every local file tool unless a
  // read_file(...) allow rule covers the path, so a local-file role without
  // coverage would only burn quota. Refuse before any confirmation or spawn.
  // Advisory only when settings are unreadable; skip_preflight is the escape
  // hatch for rules the parent cannot see (shared config, project grants).
  let preflightNotice: string | undefined;
  if (role !== "researcher" && !conversationId && !params.skip_preflight) {
    const coverage = await preflightCwdCoverage({ cwd });
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
    const gate = await authorizeWriteRole(role, { cwd, task, context, files }, {
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

  if (ctx.hasUI) ctx.ui.setStatus("pi-antigravity", `${role} · starting`);
  try {
    // Write-capable roles get the owner's Agy command allow-rule targets as
    // advisory prompt text so the model does not probe with commands headless
    // Agy would auto-deny (e.g. `python --version`); read-only roles never
    // call run_command, so no policy is loaded or sent for them.
    const commandPolicy = ROLE_CONFIGS[role].readOnly ? undefined : await loadAllowedCommands();
    const run = await runAgyWithDenialRetry({
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
      signal,
      onProgress: (progress) => {
        const text = formatProgress(role, progress.stepType, progress.textDelta);
        if (ctx.hasUI) ctx.ui.setStatus("pi-antigravity", text);
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
    if (ctx.hasUI) ctx.ui.setStatus("pi-antigravity", undefined);
  }
}

function registerRoleTool(pi: ExtensionAPI, role: AgyRole): void {
  const tool: ToolDefinition<typeof roleParameters, ToolDetails> = {
    name: `agy_${role}`,
    label: `Agy ${role}`,
    description: toolDescription(role),
    promptSnippet: `Delegate bounded ${role} work to official agy`,
    promptGuidelines: [
      `Use agy_${role} only for an explicitly bounded task and pass only explicitly selected context or file hints.`,
      role === "scout" || role === "researcher"
        ? `Treat agy_${role} as read-only; do not ask it to edit files.`
        : `agy_${role} is write-capable only after Pi confirms in TUI; it is denied in print/JSON/RPC contexts without UI.`,
      role === "scout"
        ? `Read-only, local only; no URLs.`
        : role === "researcher"
        ? `No file tools: never include "edit/revise/update file X" in the task; do the research here and hand the brief to agy_worker.`
        : `No web tools: if the task needs online sources, call agy_researcher first and pass the brief as context.`,
    ],
    parameters: roleParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      void toolCallId;
      return executeRole(role, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      return renderAgyCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderAgyResult(result, options, theme);
    },
  };
  pi.registerTool(tool);
}

function registerResearchApplyTool(pi: ExtensionAPI): void {
  const tool: ToolDefinition<typeof researchApplyParameters, ToolDetails> = {
    name: "agy_research_apply",
    label: "Agy research → apply",
    description:
      "Two-leg delegation for 'research X, then update file Y': runs agy_researcher (web-only, cited URLs) and then agy_worker with the brief as context (edits files, approved commands only). " +
      "One Pi confirmation up front, then no further prompts. Use it whenever a request needs online sources AND a workspace change; a single role cannot do both. " +
      "question must not reference local files; apply_task names what to change. Output is bounded; both legs are reported.",
    promptSnippet: "Research on the web, then apply the brief to workspace files",
    promptGuidelines: [
      "Use agy_research_apply when the user wants web research followed by a file/code change; do not split it into a bare agy_worker call.",
      "Put only the web question in `question`; put the file/code instruction in `apply_task`; explicit parent context goes to the worker leg only.",
      "It is write-capable only after Pi confirms once in TUI; it is denied in print/JSON/RPC contexts without UI.",
    ],
    parameters: researchApplyParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      void toolCallId;
      return executeResearchApply(params, signal, onUpdate, ctx, (role, legParams, legSignal, legUpdate, legCtx, internal) =>
        executeRole(role, legParams, legSignal, legUpdate, legCtx, internal),
      );
    },
    renderCall(args, theme) {
      return renderAgyCall({ task: `${args.question ?? ""} → ${args.apply_task ?? ""}`, cwd: args.cwd }, theme);
    },
    renderResult(result, options, theme) {
      return renderAgyResult(result, options, theme);
    },
  };
  pi.registerTool(tool);
}

function registerDoctorTool(pi: ExtensionAPI): void {
  const tool: ToolDefinition<typeof doctorParameters, ToolDetails> = {
    name: "agy_doctor",
    label: "Agy doctor",
    description:
      "Read-only preflight for the Agy delegation setup: agy executable and CLI version, installed role plugin, Agy settings readability, whether read_file/write_file allow rules cover the workspace, command allow rules, and sensitive-path deny rules. " +
      "Spends no model quota. Use it before delegating in a new workspace or whenever an Agy call reports a headless permission denial.",
    promptSnippet: "Check the Agy CLI, plugin, and permission rules for this workspace",
    promptGuidelines: ["Call agy_doctor first when a delegation failed with a permission denial or when working in a workspace Agy has not been used in; show its report to the user verbatim."],
    parameters: doctorParameters,
    executionMode: "sequential",
    async execute(toolCallId, params: DoctorParameters, signal, onUpdate, ctx) {
      void toolCallId;
      void signal;
      void onUpdate;
      const cwd = await validateCwd(params.cwd, ctx.cwd, [ctx.cwd]);
      const report = await runAgyDoctor({ cwd });
      return {
        content: [{ type: "text", text: report.text }],
        details: { role: "doctor", cwd, status: report.ok ? "SUCCESS" : "ERROR", response: report.text, error: report.ok ? undefined : "Agy doctor found failing checks" },
      };
    },
    renderCall(args, theme) {
      return renderAgyCall({ task: "doctor", cwd: args.cwd }, theme);
    },
    renderResult(result, options, theme) {
      return renderAgyResult(result, options, theme);
    },
  };
  pi.registerTool(tool);
}

export default function (pi: ExtensionAPI): void {
  for (const role of ROLES) registerRoleTool(pi, role);
  registerResearchApplyTool(pi);
  registerDoctorTool(pi);
  registerAgyCommands(pi);
}

export { roleParameters, ROLE_CONFIGS, ROLES };
export type { AgyRole, RoleParameters, ToolDetails };
