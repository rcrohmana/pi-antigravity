import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { boundCommandArgs } from "./schemas.ts";
import { ROLE_CONFIGS, type AgyRole } from "./roles.ts";

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

export function registerAgyCommands(pi: ExtensionAPI): void {
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
