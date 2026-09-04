import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { boundCommandArgs } from "./schemas.ts";
import { ROLE_CONFIGS, type AgyRole } from "./roles.ts";
import { buildResearchApplyPrompt } from "./research-apply.ts";

const COMMAND_ROLES: readonly AgyRole[] = ["scout", "worker", "delegate", "researcher"];

const ROLE_FRAMING: Record<AgyRole, string> = {
  scout:
    "Use the agy_scout tool for the following read-only local reconnaissance task. Do not modify anything. Report findings and risks.",
  researcher:
    "Use the web-only agy_researcher tool to research the following question with cited sources. Do not supply file hints or ask it to inspect local files.",
  worker:
    "Use the agy_worker tool to implement the following task. Expect a confirmation gate for writes.",
  delegate: "Use the agy_delegate tool for the following bounded task.",
};

export function buildRolePrompt(role: AgyRole, args: string): string {
  return `${ROLE_FRAMING[role]}\n\nTASK:\n${boundCommandArgs(args)}`;
}

export const DOCTOR_PROMPT =
  "Use the agy_doctor tool for the current workspace and show its report to the user verbatim. If any check is [FAIL], explain the fix line in one sentence and do not start any Agy delegation until it is resolved.";

function busyOrEmptyGuard(ctx: ExtensionContext, text: string, usage: string): boolean {
  if (!text) {
    ctx.ui.notify(usage, "warning");
    return false;
  }
  if (!ctx.isIdle()) {
    ctx.ui.notify("Agent is busy. Wait for it to finish, then try again.", "warning");
    return false;
  }
  return true;
}

export function registerAgyCommands(pi: ExtensionAPI): void {
  pi.registerCommand("agy_research_apply", {
    description: "Research on the web with Agy, then apply the findings to workspace files (one confirmation before writes).",
    handler: async (args, ctx: ExtensionContext) => {
      const text = (args ?? "").trim();
      if (!busyOrEmptyGuard(ctx, text, "Usage: /agy_research_apply <research question, then what to change in which file>")) return;
      pi.sendUserMessage(buildResearchApplyPrompt(text));
    },
  });
  pi.registerCommand("agy_doctor", {
    description: "Preflight the Agy CLI, role plugin, and permission rules for this workspace (no model quota).",
    handler: async (_args, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait for it to finish, then try again.", "warning");
        return;
      }
      pi.sendUserMessage(DOCTOR_PROMPT);
    },
  });
  for (const role of COMMAND_ROLES) {
    const writeGated = !ROLE_CONFIGS[role].readOnly;
    const description = writeGated
      ? `Delegate a task to the Agy ${role} role (write-capable; asks for confirmation before writes).`
      : `Delegate a task to the Agy ${role} role (read-only reconnaissance/research).`;
    pi.registerCommand(`agy_${role}`, {
      description,
      handler: async (args, ctx: ExtensionContext) => {
        const text = (args ?? "").trim();
        if (!text) {
          ctx.ui.notify(`Usage: /agy_${role} <task>`, "warning");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Agent is busy. Wait for it to finish, then try again.", "warning");
          return;
        }
        pi.sendUserMessage(buildRolePrompt(role, text));
      },
    });
  }
}
