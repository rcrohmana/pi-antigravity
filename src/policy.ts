import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";

import type { AgyRole } from "./roles.ts";

export const MAX_TASK_LENGTH = 20_000;
export const MAX_CONTEXT_LENGTH = 30_000;
export const MAX_FILE_HINTS = 100;
export const MAX_FILE_HINT_LENGTH = 1_000;

export interface ConfirmationUI {
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

export interface WriteGateRequest {
  cwd: string;
  task: string;
  context?: string;
  files?: readonly string[];
}

export interface ResearchContextGateRequest {
  cwd: string;
  task: string;
  context: string;
}

export const MAX_CONFIRMATION_TASK_CHARS = 1_000;
const MAX_CONFIRMATION_CONTEXT_CHARS = 500;
const MAX_CONFIRMATION_FILE_HINTS = 5;
const MAX_CONFIRMATION_FILE_HINT_CHARS = 240;

export function roleCanWrite(role: AgyRole): role is Extract<AgyRole, "worker" | "delegate"> {
  return role === "worker" || role === "delegate";
}

export function buildWriteConfirmationMessage(role: Extract<AgyRole, "worker" | "delegate">, request: WriteGateRequest): string {
  const sections = [
    "This starts the official agy CLI with the reviewed inputs below.",
    `Role: ${role}`,
    `Workspace (canonical): ${request.cwd}`,
    "Important: this workspace sets the child process working directory; it is not a filesystem write sandbox.",
    "Effective write scope is defined by Agy write_file(...) permission rules, which may allow other paths.",
    `Task (${request.task.length} characters):\n${boundedConfirmationPreview(request.task, MAX_CONFIRMATION_TASK_CHARS)}`,
  ];
  if (request.context) {
    sections.push(
      `Explicit context (${request.context.length} characters):\n${boundedConfirmationPreview(request.context, MAX_CONFIRMATION_CONTEXT_CHARS)}`,
    );
  }
  if (request.files?.length) {
    const visibleHints = request.files
      .slice(0, MAX_CONFIRMATION_FILE_HINTS)
      .map((file) => `- ${boundedConfirmationPreview(file, MAX_CONFIRMATION_FILE_HINT_CHARS)}`);
    const omitted = request.files.length - visibleHints.length;
    sections.push(`File hints (${request.files.length}):\n${visibleHints.join("\n")}${omitted ? `\n[${omitted} additional file hint(s) not shown]` : ""}`);
  }
  sections.push(
    "Actual capabilities:",
    "- Create and replace file content, subject to Agy write-file permission rules.",
    "- Run commands only when they match configured Agy command() allow rules.",
    "- This runner does not use --sandbox.",
    "- No direct file-deletion or nested-agent capability is available.",
    "Continue?",
  );
  return sections.join("\n\n");
}

export async function authorizeWriteRole(role: AgyRole, request: WriteGateRequest, ui: ConfirmationUI): Promise<GateDecision> {
  if (!roleCanWrite(role)) return { allowed: true };
  if (!ui.hasUI) {
    return {
      allowed: false,
      reason: `${role} can modify files and is denied when Pi has no interactive UI`,
    };
  }
  if (!ui.confirm) {
    return { allowed: false, reason: "Pi reported a UI but did not provide a confirmation function" };
  }
  const approved = await ui.confirm(`Allow Agy ${role} writes?`, buildWriteConfirmationMessage(role, request));
  return approved
    ? { allowed: true }
    : { allowed: false, reason: `Agy ${role} delegation rejected by the user` };
}

export function buildResearchContextConfirmationMessage(request: ResearchContextGateRequest): string {
  return [
    "This sends explicit context to the Agy web researcher.",
    `Workspace (canonical): ${request.cwd}`,
    `Task (${request.task.length} characters):\n${boundedConfirmationPreview(request.task, MAX_CONFIRMATION_TASK_CHARS)}`,
    `Explicit context (${request.context.length} characters):\n${boundedConfirmationPreview(request.context, MAX_CONFIRMATION_CONTEXT_CHARS)}`,
    "Web researcher capabilities:",
    "- Search the web and fetch page content; it has no local-file or command tools.",
    "- URL fetches are controlled by the owner's Agy read_url(...) rules.",
    "- If broad access such as read_url(*) is configured, untrusted web content could cause this context to be sent to an arbitrary site.",
    "Do not approve secrets, credentials, or private data. Continue?",
  ].join("\n\n");
}

export async function authorizeResearchContext(request: ResearchContextGateRequest, ui: ConfirmationUI): Promise<GateDecision> {
  if (!ui.hasUI) {
    return { allowed: false, reason: "researcher explicit context is denied in headless mode because Pi has no interactive UI" };
  }
  if (!ui.confirm) {
    return { allowed: false, reason: "Pi reported a UI but did not provide a confirmation function" };
  }
  const approved = await ui.confirm("Allow Agy researcher context?", buildResearchContextConfirmationMessage(request));
  return approved
    ? { allowed: true }
    : { allowed: false, reason: "Agy researcher context delegation rejected by the user" };
}

function boundedConfirmationPreview(value: string, maxChars: number): string {
  const sanitized = value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  if (sanitized.length <= maxChars) return sanitized;
  const marker = `\n[preview truncated: ${value.length} characters total]\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(remaining / 2);
  const tailChars = Math.floor(remaining / 2);
  return `${sanitized.slice(0, headChars)}${marker}${tailChars ? sanitized.slice(-tailChars) : ""}`;
}

function comparablePath(value: string): string {
  const normalized = normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithinPath(root: string, candidate: string): boolean {
  const rootPath = comparablePath(resolve(root));
  const candidatePath = comparablePath(resolve(candidate));
  if (rootPath === candidatePath) return true;
  const childRelative = relative(rootPath, candidatePath);
  return childRelative !== "" && !childRelative.startsWith(".." + sep) && childRelative !== ".." && !isAbsolute(childRelative);
}

export async function validateCwd(
  requested: string | undefined,
  baseCwd: string,
  allowedRoots: readonly string[] = [baseCwd],
): Promise<string> {
  if (requested !== undefined && (requested.trim() === "" || requested.includes("\0"))) {
    throw new Error("cwd must be a non-empty path without NUL characters");
  }
  if (baseCwd.includes("\0")) throw new Error("base cwd contains a NUL character");

  const candidate = resolve(baseCwd, requested ?? ".");
  const roots = await Promise.all(
    allowedRoots.map(async (root) => realpath(resolve(root))),
  );
  const candidateReal = await realpath(candidate);
  const candidateStat = await stat(candidateReal);
  if (!candidateStat.isDirectory()) throw new Error(`cwd is not a directory: ${candidate}`);
  if (!roots.some((root) => isWithinPath(root, candidateReal))) {
    throw new Error(`cwd is outside the allowed workspace: ${candidate}`);
  }
  return candidateReal;
}

export function validateTask(task: string): string {
  if (typeof task !== "string" || task.trim() === "") throw new Error("task must be non-empty");
  if (task.includes("\0")) throw new Error("task must not contain NUL characters");
  if (task.length > MAX_TASK_LENGTH) throw new Error(`task exceeds ${MAX_TASK_LENGTH} characters`);
  return task;
}

export function validateContext(context: string | undefined): string | undefined {
  if (context === undefined) return undefined;
  if (context.includes("\0")) throw new Error("context must not contain NUL characters");
  if (context.length > MAX_CONTEXT_LENGTH) throw new Error(`context exceeds ${MAX_CONTEXT_LENGTH} characters`);
  return context;
}

export function validateFileHints(files: readonly string[] | undefined): string[] | undefined {
  if (files === undefined) return undefined;
  if (files.length > MAX_FILE_HINTS) throw new Error(`files exceeds ${MAX_FILE_HINTS} entries`);
  return files.map((file) => {
    if (typeof file !== "string" || file.trim() === "" || file.includes("\0")) {
      throw new Error("files must contain non-empty paths without NUL characters");
    }
    if (file.length > MAX_FILE_HINT_LENGTH) throw new Error(`file hint exceeds ${MAX_FILE_HINT_LENGTH} characters`);
    return file;
  });
}

export function validateConversationId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) {
    throw new Error("conversation_id contains unsupported characters");
  }
  return id;
}

export function isPathLike(value: string): boolean {
  return value === parse(value).root || value.includes("/") || value.includes("\\");
}
