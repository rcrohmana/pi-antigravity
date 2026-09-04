import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type { AgyToolDetails } from "./schemas.ts";

export function renderAgyCall(
  args: { task?: string; cwd?: string },
  theme: { fg: (...args: any[]) => string; bold: (text: string) => string },
): Text {
  const task = typeof args.task === "string" ? args.task.replace(/\s+/g, " ").trim() : "";
  const cwd = typeof args.cwd === "string" ? args.cwd : ".";
  const label = theme.fg("toolTitle", theme.bold("agy"));
  return new Text(`${label} ${theme.fg("accent", cwd)} ${theme.fg("muted", task.slice(0, 120))}`, 0, 0);
}

export function renderAgyResult(
  result: AgentToolResult<AgyToolDetails>,
  options: { expanded: boolean; isPartial: boolean },
  theme: { fg: (...args: any[]) => string },
): Text {
  const details = result.details;
  if (options.isPartial || details?.partial) {
    const progress = result.content?.find((item) => item.type === "text")?.text ?? "Running…";
    return new Text(theme.fg("warning", progress.slice(-500)), 0, 0);
  }
  if (details?.error || details?.status && details.status !== "SUCCESS") {
    const message = details.error ?? `Agy status: ${details.status}`;
    if (message.startsWith("ESCALATION REQUIRED")) {
      return new Text(theme.fg("warning", `⚠ ${message}`), 0, 0);
    }
    return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
  }
  const response = result.content?.find((item) => item.type === "text")?.text?.trim() ?? "(empty response)";
  const summary = `${details?.escalationRequired ? "⚠" : "✓"} ${details?.role ?? "agy"} ${details?.durationMs ? `(${details.durationMs}ms)` : ""}`;
  const body = options.expanded ? `${summary}\n${response}` : `${summary}: ${response.replace(/\s+/g, " ").slice(0, 300)}`;
  return new Text(theme.fg("success", body), 0, 0);
}

