# Pi Antigravity Extension — Official Development Plan

**Project:** `pi-antigravity`
**Location:** `C:\Users\<you>\Agent_Tools\pi-antigravity`
**Status:** Core implementation + slash commands/skills and offline/unit validation complete. Plugin installed, Pi extension enabled, and read-only/command smoke tests executed under project-owner approval. Write rules for the four approved roots are live; broad researcher web fetch (`read_url(*)` + loopback/metadata deny guards) verified live; further command() rule additions and any delegate live test remain pending explicit approval.
**Owner:** riancr

## 1. Goal

Build a Pi extension that delegates bounded work to the official Google Antigravity CLI (`agy`) as external worker processes. Pi remains the parent/orchestrator; the extension must not implement a second Google client or access Antigravity credentials directly.

The extension will provide four role-oriented agents:

- **worker** — implementation work: inspect, edit, validate, and escalate ambiguity instead of guessing.
- **scout** — fast local codebase reconnaissance: relevant files, entry points, data flow, and risks.
- **delegate** — lightweight general-purpose delegation that follows the parent task and avoids unnecessary orchestration.
- **researcher** — web/documentation research with source URLs and a concise research brief.

## 2. Non-goals

- Do not register Antigravity as a Pi model provider.
- Do not read, copy, transform, or import Google/Antigravity auth tokens.
- Do not call undocumented Google endpoints or emulate the Antigravity client protocol.
- Do not make `--dangerously-skip-permissions` the default.
- Do not silently modify a repository, Pi settings, or Antigravity settings during initial scaffolding.
- Do not send the complete Pi conversation to Google by default; pass only the task and explicitly selected context.

## 3. Compliance and safety principles

1. Invoke the installed official `agy.exe` binary only.
2. Rely on the user's normal Antigravity login and its native credential store.
3. Use documented headless flags (`--input-format stream-json`, `--output-format stream-json`, `--agent`, `--mode`, `--sandbox`, and `--print-timeout`); send the one-turn user message over stdin.
4. Spawn with `shell: false`; resolve the executable from `AGY_CLI_PATH` or the official Windows install location as a fallback.
5. Treat Agy's non-zero exit, `ERROR`, `CANCELED`, `INTERRUPTED`, and missing final result as failures.
6. Propagate Pi cancellation to the child process and clean up all temporary resources.
7. Keep worker/delegate writes behind a Pi-side confirmation gate in interactive mode; deny write-capable delegation when no UI is available unless a future, explicit non-interactive policy is added.
8. Use scoped Agy permission rules for test/build/web access. Agy's `accept-edits` mode approves file edits but does not automatically approve shell commands.
9. Treat repository instructions and agent output as untrusted input; never let them expand the configured working directory or permission policy implicitly.

This architecture follows the supported CLI surface and is intended to avoid unofficial integration paths. It is not a legal determination of Google Terms compliance; current Google terms, account policy, and quotas remain authoritative.

## 4. Target architecture

```text
Pi parent model
    |
    | calls a typed custom tool
    v
pi-antigravity extension
    |
    | validates role, cwd, policy, and task
    | spawns official agy.exe with shell=false
    v
agy --input-format stream-json --output-format stream-json --agent <role>
    ^ one JSON user event containing the bounded task is sent over stdin
    |
    | parses init / step_update / result NDJSON
    | streams progress through onUpdate
    v
Pi tool result: final response + status + usage + conversation_id
```

### Invocation model

- **Default:** one Agy process per delegated task using headless stream-json input mode; the one-turn user message is sent over stdin to avoid Windows argv limits.
- **Continuation:** preserve `conversation_id` in tool details and optionally resume with `--conversation` when the user explicitly requests continuation.
- **Future option:** a long-lived `--input-format stream-json` process only if repeated-turn latency justifies the added lifecycle complexity.

### Context policy

- Always pass the target `cwd` and a narrowly scoped task.
- Pass files, constraints, or parent context only when explicitly supplied by the parent Pi turn.
- Do not serialize the full Pi session or hidden system prompt into the Agy request.
- Bound returned output using Pi's normal tool-output limits and preserve a diagnostic path when truncation is necessary.

## 5. Role contracts

### `scout`

- Read-only local reconnaissance.
- Use file listing, file search, code search, and file viewing tools.
- No file creation, edits, or shell commands in the role tool allow-list.
- Return: relevant files, entry points, data flow, risks, and unanswered questions.
- Run in the documented default mode with an explicit read-only tool allow-list; do not use plan mode because it changes the reconnaissance contract.

### `worker`

- Read, create/edit, and validate within the requested workspace.
- Use `accept-edits` for uninterrupted file changes after the Pi-side gate.
- Run only explicitly allowed validation commands.
- Never invent product requirements or resolve ambiguous behavior silently.
- Return: changed files, validation commands/results, decisions needed, and remaining risks.

### `delegate`

- General-purpose bounded task execution, close to the parent task intent.
- May use normal read/edit/validation capabilities after the same write gate as `worker`.
- Must not spawn nested Antigravity subagents by default.
- Keep output concise and task-focused.

### `researcher`

- Use Antigravity's web search and URL-content tools plus read-only local tools when needed.
- Do not modify the repository.
- Cite source URLs for factual claims and distinguish evidence from inference.
- Return a concise brief: question, findings, caveats, and sources.

## 6. Planned project structure

```text
pi-antigravity/
├── PLAN.md                         # This canonical development plan
├── README.md                       # Installation, usage, and safety notes
├── package.json                    # Pi package manifest
├── index.ts                        # Pi extension entry point
├── src/
│   ├── runner.ts                   # agy process lifecycle and NDJSON parser
│   ├── roles.ts                    # Role contracts and command policy
│   ├── schemas.ts                  # Tool/result schemas
│   ├── policy.ts                   # cwd, confirmation, and permission checks
│   └── render.ts                   # Compact/expanded Pi TUI rendering
├── agy-plugin/
│   ├── plugin.json                 # Official Agy local plugin manifest
│   └── agents/
│       ├── worker.md               # Agy worker definition
│       ├── scout.md                # Agy scout definition
│       ├── delegate.md              # Agy delegate definition
│       └── researcher.md            # Agy researcher definition
├── scripts/
│   ├── validate-agy-plugin.ps1     # Validate local Agy plugin
│   └── install-agy-plugin.ps1      # Explicit opt-in Agy plugin installation
├── tests/
│   ├── fixtures/                   # Captured NDJSON/error fixtures
│   ├── runner.test.mjs             # Parser, timeout, abort, and exit tests
│   ├── policy.test.mjs             # cwd and write-gate tests
│   └── extension.test.mjs          # Tool registration and result mapping
└── docs/
    ├── architecture.md             # Detailed implementation notes
    └── permissions.md               # Agy permission policy and threat model
```

The scaffold phase established the layout; the implementation files above are now present and validated offline. Approval-gated installation, enabling, and live model/E2E validation remain separate milestones.

## 7. Development milestones

### Phase 0 — Scaffold (complete)

- [x] Create the project directory under `C:\Users\<you>\Agent_Tools`.
- [x] Create source, test, docs, scripts, and Agy plugin directories.
- [x] Record this plan.
- [x] Keep plugin installation and Pi enabling deferred pending explicit approval.

**Exit criteria:** The plan exists, the structure is present, and no Pi/Agy configuration was changed by this phase.

### Phase 1 — CLI contract smoke tests

- Verify the logged-in `agy` executable and capture its version.
- Run a harmless headless prompt with `--output-format json`.
- Run a harmless prompt with `--output-format stream-json`.
- Verify `init`, incremental `step_update`, terminal `result`, usage, status, and exit-code behavior.
- Verify timeout and cancellation behavior without changing files.

**Exit criteria:** Fixtures and parser assumptions match the installed Agy version.

### Phase 2 — Agy role plugin

- Add `plugin.json` and the four Markdown agent definitions.
- Use documented Agy tool identifiers and explicit per-role tool lists.
- Configure `mainAgent`/`subagent` and command execution policy deliberately.
- Validate with `agy plugin validate`.
- Install with `agy plugin install` only after explicit approval.
- Confirm each role is discoverable through `agy agents` or a harmless headless invocation.

**Exit criteria:** Each role is selectable by `--agent <role>` and has the intended capability boundary.

### Phase 3 — Pi runner and typed tools

- Implement a cross-platform child-process runner with `shell: false`.
- Resolve `agy.exe` robustly on Windows, including a path fallback when the parent shell has stale `PATH` state.
- Parse stream NDJSON incrementally and stream concise progress via `onUpdate`.
- Implement abort, timeout, non-zero exit, malformed output, and missing-result handling.
- Return structured details: role, cwd, status, conversation ID, usage, duration, and diagnostics.
- Register four explicit Pi tools backed by shared runner code.

**Exit criteria:** Unit tests cover process and parser edge cases; the extension loads without errors.

### Phase 4 — Safety and UX

- Add Pi-side confirmation for write-capable roles.
- Deny write-capable delegation in print/JSON mode by default.
- Validate and normalize `cwd`; reject unsafe/out-of-scope paths according to policy.
- Add compact and expanded TUI rendering for role, progress, result, and errors.
- Enforce output truncation and preserve full diagnostics in a controlled temporary file when needed.
- Add optional explicit structured-output schemas for scout, worker, and researcher handoffs.

**Exit criteria:** A user can see what is running, cancel it, reject a write-capable delegation, and receive actionable failure/escalation output.

### Phase 5 — Install and integration

- Test via explicit `pi -e` loading first.
- Install the local Pi package/path only after the extension passes tests.
- Audit the existing global Pi settings for the stale `google-antigravity-multi` entry before enabling the new extension; do not remove it blindly.
- Keep the new extension source at the absolute path under `C:\Users\<you>\Agent_Tools\pi-antigravity`.
- Document reload, uninstall, and rollback steps.

**Exit criteria:** The extension loads in a normal Pi session and can run all four roles without modifying Pi core.

### Phase 6 — End-to-end validation

- `scout` against a read-only test repository.
- `researcher` against a small documentation question and verify source URLs.
- `worker` against a disposable Git repository with an intentionally simple change and allowed test command.
- `delegate` against a bounded non-destructive task.
- Verify cancellation, denied command escalation, ambiguous-task escalation, and concurrent read-only calls.
- Review logs and confirm no credentials or hidden Pi context are written by the extension.

**Exit criteria:** All acceptance tests pass and known limitations are documented.

## 8. Acceptance criteria

- The extension invokes only the official `agy.exe` CLI process.
- No auth token or cookie is read from credential files or serialized into the prompt by extension code. The Agy child inherits the parent environment as an explicit trust boundary, especially for sandboxed `run_command`.
- `scout` cannot edit through its configured Agy tool list.
- `researcher` returns source URLs and does not edit files.
- `worker` reports files changed and validation results, and emits an explicit escalation when it cannot safely decide.
- `delegate` stays bounded and does not create uncontrolled nested agents.
- Pi cancellation terminates the Agy child process.
- Agy failures are visible as Pi tool failures with useful diagnostics.
- Output is bounded and structured enough for the parent Pi model to act on.
- The extension can be enabled/disabled without changing Pi internals.

Note on headless permission behavior (verified on CLI 1.1.25; details in `docs/permissions.md`): headless mode auto-denies `read_file`/`read_url` without matching allow rules — even inside the workspace. The empirically working Windows rule form is `read_file(C:/Users/<you>/...)` (drive letter + forward slashes); drive-less and leading-slash forms do not match. Role tool allow-lists in the plugin frontmatter are enforced at runtime, so read-only roles cannot call write or web tools even though `init.tools` advertises the full catalog. Commands work headlessly only with matching `command()` allow rules and without `--sandbox` (with it, every command hits `escalate_admin` auto-denial); the runner does not emit `--sandbox`, so command safety relies on scoped command rules, the Pi write gate, and deny rules.

## 9. Decisions pending before implementation

Recommended defaults are listed first:

1. **Tool surface:** four explicit tools (`agy_scout`, `agy_worker`, `agy_delegate`, `agy_researcher`) backed by one runner.
2. **Execution:** one-shot headless process first; add persistent streaming sessions only if needed.
3. **Permissions:** scoped Agy allow-list; never default to `--dangerously-skip-permissions`.
4. **Role registration:** local Agy plugin stored in this project and explicitly installed through `agy plugin install`.
5. **Context:** task plus explicitly supplied context only; no automatic full-session forwarding.
6. **Write policy:** Pi confirmation gate for `worker` and `delegate`; deny by default when Pi has no UI.

Any deviation from these defaults must be recorded in this file before implementation proceeds.

## 10. Official references

- Antigravity CLI installation/auth: https://antigravity.google/docs/cli/install/
- Antigravity CLI headless mode: https://antigravity.google/docs/cli/headless/
- Antigravity custom subagents: https://antigravity.google/docs/subagents/
- Antigravity permissions: https://antigravity.google/docs/cli/permissions/
- Antigravity execution modes: https://antigravity.google/docs/cli/modes/
- Antigravity plugins and skills: https://antigravity.google/docs/cli/plugins/
- Pi extensions: https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Pi SDK: https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
