# pi-antigravity

Pi extension for bounded delegation to the official Google Antigravity CLI (`agy`). It exposes four explicit tools: `agy_worker`, `agy_scout`, `agy_delegate`, and `agy_researcher`.

## Safety boundary

- Only the installed official `agy.exe` is invoked, with `shell: false`.
- Executable lookup is `AGY_CLI_PATH`, then `PATH`, then `%LOCALAPPDATA%\\agy\\bin\\agy.exe`.
- Pi sends the task plus explicitly supplied context/file hints, never the full conversation or auth material in the prompt. The Agy child inherits the parent environment; treat that as a trust boundary, especially for commands.
- `worker` and `delegate` require confirmation in a Pi UI and are denied when `ctx.hasUI` is false.
- `scout` and `researcher` are read-only by their Agy tool allow-lists.
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

## Cara pakai cepat

Slash commands (type in the Pi prompt):

```text
/agy_scout <tugas>        Read-only local reconnaissance
/agy_researcher <tugas>   Read-only web/docs research with cited URLs
/agy_worker <tugas>       Implementation; asks for confirmation before writes
/agy_delegate <tugas>     Bounded delegation; asks for confirmation before writes
```

Empty arguments show a usage hint; while the agent is busy you get a "masih sibuk" notice instead of a queued call.

Natural language also works: the bundled `agy-scout`, `agy-worker`, `agy-delegate`, and `agy-researcher` skills are auto-discovered from the package `skills/` directory and trigger on requests like "scout this codebase", "research the headless docs", or "implement X with the worker". The skills just instruct the agent to call the matching tool; read-only vs write-gated behavior and the Pi write gate still apply, and bounded output/escalations come straight from the extension.

Note on headless permission behavior (verified on CLI 1.1.25; details in `docs/permissions.md`): headless Agy auto-denies `read_file`/`read_url` without matching allow rules — even inside the workspace. The proven Windows rule form is `read_file(C:/Users/<you>/...)`; drive-less and leading-slash forms do not match. Role tool allow-lists are enforced at runtime, so read-only roles cannot call write or web tools despite `init.tools` advertising the full catalog. Commands work headlessly only with matching `command()` allow rules and without `--sandbox` (with it, every command hits `escalate_admin` auto-denial); the runner does not emit `--sandbox`, so command safety relies on scoped command rules, the Pi write gate, and deny rules.
