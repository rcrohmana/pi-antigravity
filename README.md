# pi-antigravity

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
![Version](https://img.shields.io/badge/version-0.1.4-green)
![Pi extension](https://img.shields.io/badge/pi-extension-8A2BE2)

Pi extension for bounded delegation to the official Google Antigravity CLI (`agy`). It exposes six explicit tools: `agy_worker`, `agy_scout`, `agy_delegate`, `agy_researcher`, `agy_research_apply`, and `agy_doctor`.

## Agents

| Agent | Description |
|-------|-------------|
| `agy_worker` | Implementation work. Edits files, validates, escalates unapproved decisions instead of guessing |
| `agy_scout` | Fast local codebase recon: relevant files, entry points, data flow, risks |
| `agy_delegate` | A lightweight general delegate that behaves close to the parent session |
| `agy_researcher` | Web-only research with sources and a concise research brief |
| `agy_research_apply` | Composite: runs `agy_researcher` then applies the brief with `agy_worker`, behind a single confirmation |
| `agy_doctor` | Read-only preflight for the Agy CLI, role plugin, and permission rules; spends no model quota |

### Agent capabilities

This table describes each role's Agy tool allow-list. Actual file, URL, and command access is additionally controlled by the owner's Agy permission rules.

| Agent | Local inspection | Web research | Create or edit files | Run commands | Notes |
|-------|------------------|--------------|----------------------|--------------|-------|
| `agy_scout` | Yes — list directories, find files, search text, and view files | No | No | No | Read-only local reconnaissance. |
| `agy_researcher` | No | Yes — web search and page-content fetch | No | No | Web-only research; cite source URLs. Explicit context needs UI confirmation and is denied headlessly. |
| `agy_worker` | Yes | No | Yes — create and replace file content | Yes — only owner-approved command rules | For bounded implementation. Pi UI confirmation is required before it starts. |
| `agy_delegate` | Yes | No | Yes — create and replace file content | Yes — only owner-approved command rules | Lightweight bounded execution. Pi UI confirmation is required before it starts. |

No role can invoke nested agents, ask interactive follow-up questions, or change Agy permissions/configuration. Neither write-capable role has a direct file-deletion tool; command execution remains subject to the configured command allow-list.

### Routing and chaining

Each role's tool description states a hard boundary: `agy_worker`/`agy_delegate` have no web tools, `agy_researcher` has no local file tools at all, and `agy_scout` is local read-only with no web access. A single role call cannot both research and edit. For "research X, then update file Y", either call the composite `agy_research_apply` tool (one call, one confirmation, both legs run in sequence), or make two calls yourself: `agy_researcher` first to produce a brief, then `agy_worker` (or `agy_delegate`) with that brief passed as `context` so the edit is grounded in the research instead of guessed. See the "Research then edit" example under Quick start.

If a task still reaches the wrong role, it degrades instead of failing: every task prompt carries a fixed "Role limits" paragraph (`RoleConfig.degradation` in `src/roles.ts`, mirrored as a rule in each bundled plugin agent). A researcher asked to edit a file does the research and returns the full edit under a "Proposed changes" heading for `agy_worker` to apply; a worker or delegate asked for online sources completes the workspace-only parts and lists the exact research questions under "Decisions needed" instead of inventing citations; a scout names the role that can do the parts it cannot. Verified live on CLI 1.1.26 for the researcher and worker cases (no file was written, no source was fabricated).

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
- Executable lookup is `AGY_CLI_PATH`, then `PATH`, then `%LOCALAPPDATA%\\agy\\bin\\agy.exe`. The result is always normalized to an absolute path before spawn, and a bare executable name can never reach a real spawn, so Node's ambient command search cannot substitute a different binary.
- Pi sends the task plus explicitly supplied context/file hints, never the full conversation or auth material in the prompt. File hints must be single printable lines that resolve inside the selected workspace; they are rejected before any confirmation or spawn otherwise, and each is JSON-quoted on its own prompt line.
- **Child environment isolation:** every Agy child receives a fresh, minimal allow-listed environment (see "Child environment isolation" in `docs/architecture.md`). `PATH` is copied on every platform; Windows additionally receives `SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`, `APPDATA`, `ProgramData`, `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`, and `USERNAME`; Linux/macOS additionally receive `HOME`, `TMPDIR`, `TMP`, `TEMP`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `USER`, and `LOGNAME` — each only when present in the parent environment, and nothing else. Parent provider keys, generic CI, proxy, custom-CA, Node preload (`NODE_OPTIONS`), and Pi variables are intentionally not inherited, and there is no pass-through extension point. Agy authentication must use its local documented login/configuration mechanism; no role-specific credential forwarding exists.
- **Windows required-source rule:** on Windows the Node/libuv runtime copies a fixed set of process variables from the parent into any child whose spawn options omit them, below the extension's boundary. That entire set (`HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`, `SystemRoot`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR`) is allow-listed, and every `runAgy()` call on win32 — regardless of any injected test spawn implementation, which could reach the real process — requires all of it to exist in the source environment; a run with a missing name fails closed before any spawn function runs, with diagnostics that name only the missing variables, so nothing is ever filled from ambient `process.env` outside `options.env`.
- **Residual environment risks:** allow-listed `PATH`, home/temp/XDG, Windows profile, and the Windows identity variables `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`, and `USERNAME` remain trusted metadata/capability channels and can expose path topology or host identity; they are not credentials. Environment isolation does not protect on-disk credentials, a malicious executable reachable through `PATH`, child-controlled output, or a pre-existing Agy daemon holding an older environment. Command behavior may change because `CI`, locale, time-zone, proxy, custom-CA, and session variables are absent. A startup/authentication failure must be fixed by reviewing a named non-secret runtime dependency — never by restoring wholesale inheritance.
- **Validation status:** the boundary is enforced by offline tests (pure helper tests, native-host fake-spawn integration tests, and a real child/grandchild canary fixture). `runAgy()` rejects a selected platform that differs from the host platform — a simulated platform string is not runner validation. No live Agy compatibility or synthetic-canary acceptance has been run for any platform yet; it is owner-approval gated per the spec. Linux and macOS are supported by code but unvalidated.
- `worker` and `delegate` require a compact Pi UI confirmation and are denied when `ctx.hasUI` is false. It identifies the role and states that it may edit files and run approved commands, without rendering task, path, context, or file-hint previews; the runner does not use `--sandbox`. The canonical `cwd` is the child process working directory, not a filesystem write sandbox; Agy `write_file(...)` permission rules define the effective write scope.
- `scout` and `researcher` are read-only by their Agy tool allow-lists. Scout is local-only; researcher is web-only and rejects file hints. When explicit context is supplied to researcher, a Pi UI confirmation is required and headless calls are denied.
- No route uses `--dangerously-skip-permissions`; Agy's own permission rules remain authoritative.
- **Command policy prompt block:** before spawning `worker`/`delegate`, the parent reads Agy's own `settings.json` (`%USERPROFILE%\.gemini\antigravity-cli\settings.json` on Windows, `~/.gemini/antigravity-cli/settings.json` on POSIX) and extracts only the `command(<target>)` entries under `permissions.allow` (capped at 50 entries, 200 characters each). Nothing else in that file — no deny rules, no `trustedWorkspaces`, no credentials — is read or forwarded. Those targets are appended to the task prompt verbatim as a "Command policy" section telling the model that any other command, including chained (`;`/`&&`/`|`) or version-probe commands, is auto-denied headlessly and to report skipped validation instead of guessing. Scout and researcher never call commands, so they get no such block. This is advisory prompt text only; Agy's permission rules remain the runtime authority, and the settings file itself is never modified.
- **Graceful degradation instead of guessing:** each role's prompt includes a "Role limits (fixed, not negotiable)" paragraph and each plugin agent carries the same rule, so a role that lacks the tool a task needs reports the gap ("Proposed changes" for a researcher asked to edit, "Decisions needed" with research questions for a worker asked to browse) rather than fabricating results, claiming a write it could not make, or dying on an auto-denied call. Like the Command policy block, this is advisory prompt text; the runtime tool allow-lists and Agy permission rules remain the enforcement points.
- **Bounded auto-retry after a headless denial:** when a role call's first attempt ends in a headless permission denial with no substantive output (a `SUCCESS` result with an empty response and denial evidence, or a `permission_denied` failure that still carries a conversation ID), the extension continues the same Agy conversation exactly once via `--conversation <id>`, with a short policy notice naming the denied call(s) and instructing the model to finish without them. It never adds a permission, never changes role/model/mode, and sends no new context or file hints; a run that already produced substantive text despite a denial is returned as-is with no retry. The tool parameter `auto_retry` (default `true`) disables this per call. The first attempt's denial notice is always preserved in the model-visible output (`[Agy auto-retry]`) so the owner can still add the suggested allow rule. Cost is at most one extra model turn. See "Auto-retry" in `docs/architecture.md`.
- **Composite `agy_research_apply`:** one Pi UI confirmation covers both legs (researcher, then worker); it is denied headlessly. The worker leg runs with an internal `skipWriteGate` that index.ts only honors when `ctx.hasUI` is true, so there is never a second confirmation and headless calls are never silently write-capable. The researcher leg never receives the caller's explicit `context` or `files` — those are reserved for the worker leg. See "Composite research_apply" in `docs/architecture.md`.
- **Doctor / preflight:** `agy_doctor` (and `/agy_doctor`) is read-only and spends no model quota; it only spawns `agy --version` and `agy agent` (through the same isolated child environment, absolute executable, `shell: false`, bounded output, 15 s timeout as a real delegation) and reads the Agy settings file. A cheaper version of the same settings read also runs automatically before every role-tool call except `researcher` and explicit conversation continuations: when a `read_file(...)` rule does not cover `cwd`, the call is refused before any confirmation or spawn; when write coverage or settings themselves are missing, a `[Agy preflight]` notice is prefixed to the result instead. The tool parameter `skip_preflight` (default `false`) is the escape hatch for rules the preflight cannot see (shared config, project-level grants). See "Doctor and preflight" in `docs/architecture.md`.
- Child cancellation and deadlines terminate the process; output and diagnostics are bounded.

## Development checks

From this directory:

```text
npm test
npm run static
npm run check
```

These checks use Node's built-in test runner and do not call a model. They do not install or enable the Agy plugin. `npm run check` also runs `npm run typecheck`: a deterministic TypeScript type check over the dependency-free production sources (`src/runner.ts`, `src/env.ts`, `src/agy-settings.ts`, `src/schemas.ts`, `src/policy.ts`, `src/roles.ts`, `src/retry.ts`, `src/research-apply.ts`, `src/execute-role.ts`, `src/doctor.ts` via `tsconfig.check.json`) using the repository-local pinned devDependencies (`typescript` 7.0.2, `@types/node` 22.19.19). The pi-coding-agent-coupled entry points (`index.ts`, `src/commands.ts`, `src/render.ts`) are outside that type check's coverage, so this is not a claim of full-project typechecking. The role-tool execution path itself (`src/execute-role.ts`: validation, cwd preflight, the Pi write gate and researcher-context gate, command policy, progress forwarding, status cleanup, notices) is type-checked and covered end-to-end by `tests/execute-role.test.mjs` with a fake Pi context and an injected runner, so `index.ts` is reduced to tool registration.

## Local Agy plugin

The role definitions live under `agy-plugin/`. Validate without installing:

```powershell
.\\scripts\\validate-agy-plugin.ps1
```

Installation is a separate explicit action and requires `-ConfirmInstall`:

```powershell
.\\scripts\\install-agy-plugin.ps1 -ConfirmInstall
```

Review `docs/architecture.md` and `docs/permissions.md` before enabling the extension or installing the plugin.

## Quick start

Slash commands (type in the Pi prompt):

```text
/agy_scout <task>              Read-only local reconnaissance
/agy_researcher <task>         Read-only web/docs research with cited URLs
/agy_worker <task>             Implementation; asks for confirmation before writes
/agy_delegate <task>           Bounded delegation; asks for confirmation before writes
/agy_research_apply <request>  Research on the web, then apply the findings; one confirmation
/agy_doctor                    Preflight the Agy CLI, plugin, and permission rules; no model quota
```

Recommended first run in a new workspace: `/agy_doctor`. It is read-only and spends no model quota, and it catches the most common cause of a wasted delegation — a missing `read_file(...)`/`write_file(...)` allow rule for the workspace — before any role call spends quota on it.

Empty arguments show a usage hint; while the agent is busy you get an "agent busy" notice instead of a queued call.

Natural language also works: the bundled `agy-scout`, `agy-worker`, `agy-delegate`, `agy-researcher`, and `agy-research-apply` skills are auto-discovered from the package `skills/` directory and trigger on requests like "scout this codebase", "research the headless docs", or "research X then update file Y". The skills just instruct the agent to call the matching tool; read-only vs write-gated behavior and the Pi write gate still apply, and bounded output/escalations come straight from the extension.

Research then edit — the composite tool does this in one call, with one confirmation covering both legs:

```text
/agy_research_apply Research the current recommended Vsh methods with sources, then revise docs/plan.md using the brief and validate the Markdown.
```

The tool splits the request into a research question (sent to `agy_researcher`, no file references) and an apply task (sent to `agy_worker` with the research brief as `context`), so the edit is grounded in the research instead of guessed. Worker will not run commands outside its owner-approved allow rules and will say so — including any ad hoc probes like `python --version` — rather than fail silently.

The manual two-call form still works when you want to inspect or edit the brief yourself before it reaches the worker, or when you need `agy_researcher` output without any file edit at all:

```text
/agy_researcher What are the current recommended Vsh methods, with sources?
/agy_worker Revise docs/plan.md using the brief below, then validate the Markdown.

<paste the researcher's brief here as context>
```

Note on headless permission behavior (verified on CLI 1.1.25 and re-verified on 1.1.26; details in `docs/permissions.md`): headless Agy auto-denies `read_file`/`read_url` without matching allow rules — even inside the workspace. The proven Windows rule form is `read_file(C:/Users/<you>/...)`; drive-less and leading-slash forms do not match. Role tool allow-lists are enforced at runtime, so read-only roles cannot call write or web tools despite `init.tools` advertising the full catalog. Commands work headlessly only with matching `command()` allow rules and without `--sandbox` (with it, every command hits `escalate_admin` auto-denial); the runner does not emit `--sandbox`, so command safety relies on scoped command rules, the Pi write gate, and deny rules. On 1.1.26 a denied tool step (e.g. a `run_command` call outside the allow-list) now also surfaces as a `denied_actions` entry on the terminal `result`, on either a `SUCCESS` result with an empty response or a `CANCELED` result. In both cases the extension reports an actionable notice naming the denied tool, its bounded argument, and a suggested allow rule to add — instead of a bare "finished with status CANCELED" that reads like a user cancel.
