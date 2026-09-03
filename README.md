# pi-antigravity

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
![Version](https://img.shields.io/badge/version-0.1.2-green)
![Pi extension](https://img.shields.io/badge/pi-extension-8A2BE2)

Pi extension for bounded delegation to the official Google Antigravity CLI (`agy`). It exposes four explicit tools: `agy_worker`, `agy_scout`, `agy_delegate`, and `agy_researcher`.

## Agents

| Agent | Description |
|-------|-------------|
| `agy_worker` | Implementation work. Edits files, validates, escalates unapproved decisions instead of guessing |
| `agy_scout` | Fast local codebase recon: relevant files, entry points, data flow, risks |
| `agy_delegate` | A lightweight general delegate that behaves close to the parent session |
| `agy_researcher` | Web-only research with sources and a concise research brief |

### Agent capabilities

This table describes each role's Agy tool allow-list. Actual file, URL, and command access is additionally controlled by the owner's Agy permission rules.

| Agent | Local inspection | Web research | Create or edit files | Run commands | Notes |
|-------|------------------|--------------|----------------------|--------------|-------|
| `agy_scout` | Yes — list directories, find files, search text, and view files | No | No | No | Read-only local reconnaissance. |
| `agy_researcher` | No | Yes — web search and page-content fetch | No | No | Web-only research; cite source URLs. Explicit context needs UI confirmation and is denied headlessly. |
| `agy_worker` | Yes | No | Yes — create and replace file content | Yes — only owner-approved command rules | For bounded implementation. Pi UI confirmation is required before it starts. |
| `agy_delegate` | Yes | No | Yes — create and replace file content | Yes — only owner-approved command rules | Lightweight bounded execution. Pi UI confirmation is required before it starts. |

No role can invoke nested agents, ask interactive follow-up questions, or change Agy permissions/configuration. Neither write-capable role has a direct file-deletion tool; command execution remains subject to the configured command allow-list.

### Model and reasoning policy

The extension pins every role to a Gemini 3.8 Flash model variant. Agy publishes these variants with their reasoning tier in the model slug, so the extension does not add a separate `--effort` flag that could conflict with the selected tier. Individual tool calls cannot override this policy.

| Agent | Model | Reasoning tier |
|-------|-------|----------------|
| `agy_scout` | `gemini-3.8-flash-medium` | Medium |
| `agy_researcher` | `gemini-3.8-flash-high` | High |
| `agy_worker` | `gemini-3.8-flash-high` | High |
| `agy_delegate` | `gemini-3.8-flash-medium` | Medium |

## Install

Install into Pi:

```text
pi install https://github.com/rcrohmana/pi-antigravity
```

Alternative form:

```text
pi install git:github.com/rcrohmana/pi-antigravity
```

Or try it without installing:

```text
pi -e https://github.com/rcrohmana/pi-antigravity
```

Prerequisites:

1. Google Antigravity CLI (`agy`) installed and logged in.
2. The bundled Agy role plugin installed: run `scripts/install-agy-plugin.ps1 -ConfirmInstall` (or `agy plugin install <path-to-agy-plugin>`).
3. Agy permissions configured per `docs/permissions.md` (headless allow/deny rules for the files, URLs, and commands your roles need).

## Safety boundary

- Only the installed official `agy.exe` is invoked, with `shell: false`.
- Executable lookup is `AGY_CLI_PATH`, then `PATH`, then `%LOCALAPPDATA%\\agy\\bin\\agy.exe`.
- Pi sends the task plus explicitly supplied context/file hints, never the full conversation or auth material in the prompt. The Agy child inherits the parent environment; treat that as a trust boundary, especially for commands.
- `worker` and `delegate` require confirmation in a Pi UI and are denied when `ctx.hasUI` is false. The confirmation shows the role, canonical workspace, bounded task/context previews, file hints, and actual write/command capabilities; the runner does not use `--sandbox`. The canonical `cwd` is the child process working directory, not a filesystem write sandbox; Agy `write_file(...)` permission rules define the effective write scope.
- `scout` and `researcher` are read-only by their Agy tool allow-lists. Scout is local-only; researcher is web-only and rejects file hints. When explicit context is supplied to researcher, a Pi UI confirmation is required and headless calls are denied.
- No route uses `--dangerously-skip-permissions`; Agy's own permission rules remain authoritative.
- Child cancellation and deadlines terminate the process; output and diagnostics are bounded.

## Development checks

From this directory:

```text
npm test
npm run static
npm run check
```

These checks use Node's built-in test runner and do not call a model. They do not install or enable the Agy plugin.

## Local Agy plugin

The role definitions live under `agy-plugin/`. Validate without installing:

```powershell
.\\scripts\\validate-agy-plugin.ps1
```

Installation is a separate explicit action and requires `-ConfirmInstall`:

```powershell
.\\scripts\\install-agy-plugin.ps1 -ConfirmInstall
```

Review `PLAN.md`, `docs/architecture.md`, and `docs/permissions.md` before enabling the extension or installing the plugin.

## Quick start

Slash commands (type in the Pi prompt):

```text
/agy_scout <task>        Read-only local reconnaissance
/agy_researcher <task>   Read-only web/docs research with cited URLs
/agy_worker <task>       Implementation; asks for confirmation before writes
/agy_delegate <task>     Bounded delegation; asks for confirmation before writes
```

Empty arguments show a usage hint; while the agent is busy you get an "agent busy" notice instead of a queued call.

Natural language also works: the bundled `agy-scout`, `agy-worker`, `agy-delegate`, and `agy-researcher` skills are auto-discovered from the package `skills/` directory and trigger on requests like "scout this codebase", "research the headless docs", or "implement X with the worker". The skills just instruct the agent to call the matching tool; read-only vs write-gated behavior and the Pi write gate still apply, and bounded output/escalations come straight from the extension.

Note on headless permission behavior (verified on CLI 1.1.25; details in `docs/permissions.md`): headless Agy auto-denies `read_file`/`read_url` without matching allow rules — even inside the workspace. The proven Windows rule form is `read_file(C:/Users/<you>/...)`; drive-less and leading-slash forms do not match. Role tool allow-lists are enforced at runtime, so read-only roles cannot call write or web tools despite `init.tools` advertising the full catalog. Commands work headlessly only with matching `command()` allow rules and without `--sandbox` (with it, every command hits `escalate_admin` auto-denial); the runner does not emit `--sandbox`, so command safety relies on scoped command rules, the Pi write gate, and deny rules.
