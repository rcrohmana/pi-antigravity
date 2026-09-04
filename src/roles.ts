import type { AgyStatus } from "./schemas.ts";

export const ROLES = ["worker", "scout", "delegate", "researcher"] as const;
export type AgyRole = (typeof ROLES)[number];

export interface RoleConfig {
  agent: AgyRole;
  readOnly: boolean;
  mode: "default" | "accept-edits";
  commandExecutionPolicy: "off" | "sandbox";
  model: string;
  reasoningTier: "medium" | "high";
  tools: readonly string[];
  summary: string;
  boundary: string;
}

const READ_TOOLS = ["list_dir", "find_by_name", "grep_search", "view_file"] as const;
const WRITE_TOOLS = [
  ...READ_TOOLS,
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "run_command",
] as const;
const RESEARCH_TOOLS = [
  "search_web",
  "read_url_content",
] as const;

export const ROLE_CONFIGS: Record<AgyRole, RoleConfig> = {
  scout: {
    agent: "scout",
    model: "gemini-3.8-flash-medium",
    reasoningTier: "medium",
    readOnly: true,
    mode: "default",
    commandExecutionPolicy: "off",
    tools: READ_TOOLS,
    summary: "Read-only local reconnaissance: files, entry points, data flow, risks, and questions.",
    boundary: "Local read-only inspection only (list/find/grep/view). No web tools, no file writes, and no commands. Cannot fetch URLs.",
  },
  researcher: {
    agent: "researcher",
    model: "gemini-3.8-flash-high",
    reasoningTier: "high",
    readOnly: true,
    mode: "default",
    commandExecutionPolicy: "off",
    tools: RESEARCH_TOOLS,
    summary: "Web-only research with source URLs and a concise brief; it has no local-file tools.",
    boundary: "Web-only (search_web, read_url_content) with cited URLs. No local file access at all: cannot read, list, edit, or create workspace files, and cannot run commands. Never send it a task that mentions editing or reading a file.",
  },
  worker: {
    agent: "worker",
    model: "gemini-3.8-flash-high",
    reasoningTier: "high",
    readOnly: false,
    mode: "accept-edits",
    commandExecutionPolicy: "sandbox",
    tools: WRITE_TOOLS,
    summary: "Bounded implementation and explicitly allowed validation in the requested workspace.",
    boundary: "Reads, creates, and edits workspace files; runs only owner-approved commands listed in its Command policy. No web tools: cannot search the web or fetch URLs. For tasks that need web research and file edits, run agy_researcher first and pass its brief as context to agy_worker.",
  },
  delegate: {
    agent: "delegate",
    model: "gemini-3.8-flash-medium",
    reasoningTier: "medium",
    readOnly: false,
    mode: "accept-edits",
    commandExecutionPolicy: "sandbox",
    tools: WRITE_TOOLS,
    summary: "Lightweight bounded execution without nested Antigravity delegation.",
    boundary: "Same tools as worker (files and owner-approved commands, no web); lighter, medium reasoning, for small bounded tasks. No web tools: cannot search the web or fetch URLs. For tasks that need web research and file edits, run agy_researcher first and pass its brief as context to agy_delegate.",
  },
};

export const ROLE_CHAINING_GUIDE =
  "Routing: local inspection only -> agy_scout. Web research only -> agy_researcher. " +
  "Edit files (no web) -> agy_worker (or agy_delegate for small tasks). " +
  "Research then edit -> two calls: agy_researcher first, then agy_worker with the researcher brief as context. " +
  "Never give one role a task it has no tools for; it will fail without output.";

export function isAgyRole(value: string): value is AgyRole {
  return (ROLES as readonly string[]).includes(value);
}

export function roleConfig(role: AgyRole): RoleConfig {
  return ROLE_CONFIGS[role];
}

export type RoleTerminalStatus = AgyStatus;
