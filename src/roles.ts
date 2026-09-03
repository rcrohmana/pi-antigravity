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
  ...READ_TOOLS,
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
  },
  researcher: {
    agent: "researcher",
    model: "gemini-3.8-flash-high",
    reasoningTier: "high",
    readOnly: true,
    mode: "default",
    commandExecutionPolicy: "off",
    tools: RESEARCH_TOOLS,
    summary: "Read-only documentation and web research with source URLs and a concise brief.",
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
  },
};

export function isAgyRole(value: string): value is AgyRole {
  return (ROLES as readonly string[]).includes(value);
}

export function roleConfig(role: AgyRole): RoleConfig {
  return ROLE_CONFIGS[role];
}

export type RoleTerminalStatus = AgyStatus;
