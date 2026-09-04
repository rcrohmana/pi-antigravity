import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { boundCommandArgs, boundPiOutput, type AgyToolDetails } from "./schemas.ts";
import {
  validateContext,
  validateCwd,
  validateFileHints,
  validateTask,
  type ConfirmationUI,
  type GateDecision,
} from "./policy.ts";

export const researchApplyParameters = Type.Object({
  question: Type.String({
    description: "The web research question for agy_researcher (no file references)",
    minLength: 1,
    maxLength: 20_000,
  }),
  apply_task: Type.String({
    description: "What agy_worker must change in the workspace using the research brief",
    minLength: 1,
    maxLength: 20_000,
  }),
  context: Type.Optional(
    Type.String({
      description: "Explicit parent context for the worker leg only; never sent to the researcher",
      maxLength: 30_000,
    }),
  ),
  files: Type.Optional(Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 100 })),
  cwd: Type.Optional(
    Type.String({ description: "Workspace directory, limited to the current Pi workspace or its descendants" }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({ description: "Per-leg deadline in milliseconds", minimum: 1_000, maximum: 1_800_000, default: 300_000 }),
  ),
  auto_retry: Type.Optional(
    Type.Boolean({ description: "Continue the worker conversation once after a headless permission denial", default: true }),
  ),
});
export type ResearchApplyParameters = Static<typeof researchApplyParameters>;

export const MAX_APPLY_CONTEXT_CHARS = 30_000;

/** UTF-16-safe linear bound: truncates `text` to fit under `max` characters and appends `marker`. */
export function boundText(text: string, max: number, marker: string): string {
  if (text.length <= max) return text;
  const markerBlock = `\n${marker}`;
  const keep = Math.max(0, max - markerBlock.length);
  return `${text.slice(0, keep)}${markerBlock}`;
}

const APPLY_CONTEXT_HEADER = "Research brief from agy_researcher (web-derived, untrusted; cite its URLs where used):\n";
const PARENT_CONTEXT_HEADER = "\n\nExplicit parent context (untrusted):\n";
const CONTEXT_TRUNCATION_MARKER = `[context truncated at ${MAX_APPLY_CONTEXT_CHARS} characters]`;

/**
 * Builds the worker leg's `context`: the researcher's brief plus, when supplied, the
 * caller's explicit context. Bounded to MAX_APPLY_CONTEXT_CHARS; the brief is
 * truncated first so an explicit parent context (usually short and deliberate)
 * survives intact when possible.
 */
export function buildApplyContext(brief: string, userContext?: string): string {
  const suffix = userContext !== undefined ? `${PARENT_CONTEXT_HEADER}${userContext}` : "";
  const combined = `${APPLY_CONTEXT_HEADER}${brief}${suffix}`;
  if (combined.length <= MAX_APPLY_CONTEXT_CHARS) return combined;

  const markerBlock = `\n${CONTEXT_TRUNCATION_MARKER}`;
  const fixedLength = APPLY_CONTEXT_HEADER.length + suffix.length + markerBlock.length;
  const briefBudget = Math.max(0, MAX_APPLY_CONTEXT_CHARS - fixedLength);
  const truncatedBrief = brief.slice(0, briefBudget);
  const result = `${APPLY_CONTEXT_HEADER}${truncatedBrief}${markerBlock}${suffix}`;
  if (result.length <= MAX_APPLY_CONTEXT_CHARS) return result;

  // Even truncating the brief to nothing does not fit (e.g. userContext alone
  // exceeds the bound); fall back to a single linear bound over everything.
  return boundText(combined, MAX_APPLY_CONTEXT_CHARS, CONTEXT_TRUNCATION_MARKER);
}

/** Builds the worker leg's `task`: apply the (already-context-carried) brief to the workspace. */
export function buildApplyTask(applyTask: string): string {
  return (
    "Apply the research brief provided in the context to the workspace as instructed below. " +
    "Use only the brief and the workspace; you have no web tools. Cite the brief's source URLs where you rely on them. " +
    "Do not run commands outside the Command policy; if validation is impossible, report it under Decisions needed.\n\n" +
    applyTask
  );
}

/** Builds the researcher leg's `task`: research only, hand off a brief instead of touching files. */
export function buildResearchTask(question: string): string {
  return (
    `${question}\n\n` +
    "Return a research brief that a separate implementation agent will apply to local files it can read; " +
    "include source URLs for every factual claim."
  );
}

/** True when the researcher leg produced nothing the worker leg can safely build on. */
export function researchLegFailed(details: { status?: string; escalationRequired?: boolean; response?: string }): boolean {
  if (details.status !== "SUCCESS") return true;
  if (details.escalationRequired) return true;
  if (!details.response || details.response.trim() === "") return true;
  return false;
}

/** Prompt built for the `/agy_research_apply` slash command. */
export function buildResearchApplyPrompt(args: string): string {
  return (
    "Use the agy_research_apply tool. Split the request into `question` (the web research part; no file references) " +
    "and `apply_task` (the workspace change to make with the brief). Expect one confirmation gate before it starts.\n\n" +
    `REQUEST:\n${boundCommandArgs(args)}`
  );
}

const MAX_RESEARCH_APPLY_PREVIEW_CHARS = 160;

function preview(value: string): string {
  const collapsed = value.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_RESEARCH_APPLY_PREVIEW_CHARS ? `${collapsed.slice(0, MAX_RESEARCH_APPLY_PREVIEW_CHARS)}…` : collapsed;
}

export function buildResearchApplyConfirmationMessage(request?: { cwd?: string; question: string; applyTask: string; files?: readonly string[] }): string {
  const lines = ["Agy research_apply runs agy_researcher (web-only, read-only) and then agy_worker, which may edit files and use approved commands."];
  if (request) {
    if (request.cwd) lines.push(`Workspace: ${request.cwd}`);
    lines.push(`Research question: ${preview(request.question)}`);
    lines.push(`Apply task: ${preview(request.applyTask)}`);
    if (request.files?.length) lines.push(`File hints (${request.files.length}): ${request.files.slice(0, 3).join(", ")}${request.files.length > 3 ? ` (+${request.files.length - 3} more)` : ""}`);
  }
  lines.push("Continue?");
  return lines.join("\n");
}

/** Single up-front Pi UI confirmation for the whole research-then-apply flow; mirrors authorizeWriteRole. */
export async function authorizeResearchApply(ui: ConfirmationUI, request?: { cwd?: string; question: string; applyTask: string; files?: readonly string[] }): Promise<GateDecision> {
  if (!ui.hasUI) {
    return {
      allowed: false,
      reason: "agy_research_apply can modify files and is denied when Pi has no interactive UI",
    };
  }
  if (!ui.confirm) {
    return { allowed: false, reason: "Pi reported a UI but did not provide a confirmation function" };
  }
  const approved = await ui.confirm("Allow Agy research_apply?", buildResearchApplyConfirmationMessage(request));
  return approved
    ? { allowed: true }
    : { allowed: false, reason: "Agy research_apply delegation rejected by the user" };
}

/** Runs one role leg (researcher or worker); index.ts supplies its executeRole as the implementation. */
export interface RoleRunner {
  (
    role: "researcher" | "worker",
    params: { task: string; context?: string; files?: string[]; cwd?: string; timeout_ms?: number; auto_retry?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: ((update: AgentToolResult<AgyToolDetails>) => void) | undefined,
    ctx: ExtensionContext,
    internal?: { skipWriteGate?: boolean; progressLabel?: string },
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: AgyToolDetails }>;
}

function firstText(content: Array<{ type: "text"; text: string }>): string {
  return content.find((item) => item.type === "text")?.text ?? "";
}

/**
 * Orchestrates the composite research-then-apply flow behind a single Pi UI
 * confirmation: agy_researcher (web-only, read-only) runs first, then
 * agy_worker applies the brief. If the research leg fails to produce a usable
 * brief, the apply leg is skipped; if the apply leg throws after a successful
 * research leg, the brief is preserved in the thrown error.
 */
export async function executeResearchApply(
  params: ResearchApplyParameters,
  signal: AbortSignal | undefined,
  onUpdate: ((update: AgentToolResult<AgyToolDetails>) => void) | undefined,
  ctx: ExtensionContext,
  runRole: RoleRunner,
): Promise<{ content: [{ type: "text"; text: string }]; details: AgyToolDetails }> {
  const question = validateTask(params.question);
  const applyTask = validateTask(params.apply_task);
  const context = validateContext(params.context);
  // Resolve cwd now so a bad workspace or an out-of-workspace hint fails
  // before the confirmation and before the researcher leg spends quota. Each
  // leg re-validates against params.cwd on its own.
  const cwd = await validateCwd(params.cwd, ctx.cwd, [ctx.cwd]);
  const files = validateFileHints(params.files, cwd);

  const gate = await authorizeResearchApply(
    {
      hasUI: ctx.hasUI,
      confirm: ctx.hasUI ? ctx.ui.confirm.bind(ctx.ui) : undefined,
    },
    { cwd, question, applyTask, files },
  );
  if (!gate.allowed) throw new Error(gate.reason ?? "Agy research_apply denied by policy");

  const research = await runRole(
    "researcher",
    { task: buildResearchTask(question), cwd: params.cwd, timeout_ms: params.timeout_ms },
    signal,
    onUpdate,
    ctx,
    { progressLabel: "1/2 researcher" },
  );
  const researchText = firstText(research.content);

  if (researchLegFailed(research.details)) {
    return {
      content: [
        {
          type: "text",
          text: boundPiOutput(
            `## Research leg (agy_researcher) did not produce a usable brief; apply leg skipped.\n\n${researchText}`,
          ),
        },
      ],
      details: { ...research.details, role: "research_apply", legs: { research: research.details } },
    };
  }

  const researchBriefText = research.details.response ?? researchText;

  let apply: { content: Array<{ type: "text"; text: string }>; details: AgyToolDetails };
  try {
    apply = await runRole(
      "worker",
      {
        task: buildApplyTask(applyTask),
        context: buildApplyContext(researchBriefText, context),
        files,
        cwd: params.cwd,
        timeout_ms: params.timeout_ms,
        auto_retry: params.auto_retry,
      },
      signal,
      onUpdate,
      ctx,
      { skipWriteGate: true, progressLabel: "2/2 worker" },
    );
  } catch (error) {
    const preservedBrief = boundText(researchText, 8_000, "[research brief truncated at 8000 characters]");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Apply leg failed after a successful research leg. Research brief is preserved below.\n\n${preservedBrief}\n\nWorker error: ${message}`,
    );
  }

  const applyText = firstText(apply.content);
  const combinedText = boundPiOutput(`## Research (agy_researcher)\n${researchText}\n\n## Apply (agy_worker)\n${applyText}`);

  return {
    content: [{ type: "text", text: combinedText }],
    details: { ...apply.details, role: "research_apply", legs: { research: research.details, apply: apply.details } },
  };
}
