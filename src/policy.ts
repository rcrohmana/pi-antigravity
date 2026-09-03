import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, parse, relative, resolve, sep } from "node:path";

import type { AgyRole } from "./roles.ts";

export const MAX_TASK_LENGTH = 20_000;
export const MAX_CONTEXT_LENGTH = 30_000;
export const MAX_FILE_HINTS = 100;
export const MAX_FILE_HINT_LENGTH = 1_000;

export interface WriteGateUI {
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

export function roleCanWrite(role: AgyRole): boolean {
  return role === "worker" || role === "delegate";
}

export async function authorizeWriteRole(role: AgyRole, ui: WriteGateUI): Promise<GateDecision> {
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
  const approved = await ui.confirm(
    `Allow Agy ${role} writes?`,
    "This delegates to the official agy CLI with workspace file-edit capability and possible sandboxed command execution, still subject to Agy's own permission policy. Continue?",
  );
  return approved
    ? { allowed: true }
    : { allowed: false, reason: `Agy ${role} delegation rejected by the user` };
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
