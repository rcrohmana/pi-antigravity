import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { renderAgyCall, renderAgyResult } from "./src/render.ts";
import { runAgyDoctor } from "./src/doctor.ts";
import { executeRole, roleParameters, type RoleParameters } from "./src/execute-role.ts";
import { executeResearchApply, researchApplyParameters } from "./src/research-apply.ts";
import { registerAgyCommands } from "./src/commands.ts";
import { ROLE_CHAINING_GUIDE, ROLE_CONFIGS, ROLES, type AgyRole } from "./src/roles.ts";
import { validateCwd } from "./src/policy.ts";
import type { AgyToolDetails } from "./src/schemas.ts";

const doctorParameters = Type.Object({
  cwd: Type.Optional(Type.String({ description: "Workspace directory to check, limited to the current Pi workspace or its descendants" })),
});
type DoctorParameters = Static<typeof doctorParameters>;

type ToolDetails = AgyToolDetails;

function toolDescription(role: AgyRole): string {
  const config = ROLE_CONFIGS[role];
  const write = config.readOnly ? "read-only" : "write-capable and requires confirmation";
  return `Delegate a bounded task to the official agy CLI using the ${role} role (${write}). ${config.summary} ${config.boundary} ${ROLE_CHAINING_GUIDE} Output is bounded; no full Pi conversation is forwarded.`;
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
