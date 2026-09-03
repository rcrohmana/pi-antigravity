import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { formatProgress, renderAgyCall, renderAgyResult } from "./src/render.ts";
import { formatModelVisibleResponse, runAgy } from "./src/runner.ts";
import { registerAgyCommands } from "./src/commands.ts";
import { ROLE_CONFIGS, ROLES, type AgyRole } from "./src/roles.ts";
import {
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
});
type RoleParameters = Static<typeof roleParameters>;

type ToolDetails = AgyToolDetails;
type ToolUpdate = AgentToolResult<ToolDetails>;

function toolDescription(role: AgyRole): string {
  const config = ROLE_CONFIGS[role];
  const write = config.readOnly ? "read-only" : "write-capable and requires confirmation";
  return `Delegate a bounded task to the official agy CLI using the ${role} role (${write}). ${config.summary} Output is bounded; no full Pi conversation is forwarded.`;
}

async function executeRole(
  role: AgyRole,
  params: RoleParameters,
  signal: AbortSignal | undefined,
  onUpdate: ((update: ToolUpdate) => void) | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const task = validateTask(params.task);
  const context = validateContext(params.context);
  const files = validateFileHints(params.files);
  const conversationId = validateConversationId(params.conversation_id);
  const cwd = await validateCwd(params.cwd, ctx.cwd, [ctx.cwd]);
  const gate = await authorizeWriteRole(role, { cwd, task, context, files }, {
    hasUI: ctx.hasUI,
    confirm: ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : undefined,
  });
  if (!gate.allowed) throw new Error(gate.reason ?? "Agy delegation denied by policy");

  if (ctx.hasUI) ctx.ui.setStatus("pi-antigravity", `${role} · starting`);
  try {
    const run = await runAgy({
      role,
      task,
      cwd,
      context,
      files,
      timeoutMs: params.timeout_ms,
      conversationId,
      model: ROLE_CONFIGS[role].model,
      mode: ROLE_CONFIGS[role].mode,
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
    return {
      content: [{ type: "text", text: formatModelVisibleResponse(run) }],
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

export default function (pi: ExtensionAPI): void {
  for (const role of ROLES) registerRoleTool(pi, role);
  registerAgyCommands(pi);
}

export { roleParameters, ROLE_CONFIGS, ROLES };
export type { AgyRole, RoleParameters, ToolDetails };
