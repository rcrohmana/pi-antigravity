# A-04: Child Environment Isolation Specification

**Status:** Draft for owner review — no implementation, live model call, configuration change, or environment change is authorized by this document alone.

## 1. Problem statement

`runAgy()` currently resolves `env` as `options.env ?? process.env` and passes that same object to the `agy.exe` child. Consequently, every environment variable visible to the Pi parent process is visible to Agy and, for ordinary direct descendants, to commands started by Agy.

This is a material secret-exposure boundary. Even with a narrow `command()` policy, an approved project command such as `npm test` can execute arbitrary project code, and that code normally inherits Agy's environment.

The remediation must make Agy receive a freshly constructed, minimal environment. It must not rely on a blacklist of provider names.

## 2. Security objective and trust assumptions

After this change:

1. The immediate `agy` process receives only explicitly allow-listed platform/runtime variables.
2. Provider keys, Pi variables, CI credentials, proxy credentials, and every other non-allow-listed parent variable are absent from the environment block passed to Agy.
3. Ordinary processes launched directly or transitively by that Agy process inherit the sanitized environment unless Agy explicitly replaces it.
4. Agy can still find its installed plugin, user-level login/configuration, temporary directory, and approved command executables.
5. No extension code path silently falls back to forwarding the complete parent environment.
6. Unsupported platforms and unresolved runtime dependencies fail before Agy starts; they do not fall back to ambient inheritance.

The goal is containment of environment-variable secrets at the Pi-to-Agy process boundary. It does not make a malicious Agy binary, a malicious executable on `PATH`, user-supplied task/context text, on-disk credentials, or allow-listed variable values trustworthy.

The descendant guarantee assumes the tested Agy version executes commands in the sanitized process tree. Agy must not reconnect to a pre-existing daemon or service that retained Pi's original environment, and it must not reconstruct parent variables from another source. Unit tests prove the immediate spawn boundary; an approved synthetic-canary live test verifies this assumption for the supported Agy version.

Allow-listed path and identity variables are metadata and capability-bearing inputs, not secrets by definition. Their values may reveal usernames or directory topology, influence executable/configuration discovery, or contain sensitive text on an unusually configured host. The guarantee is name-based environment minimization, not arbitrary value classification.

## 3. Scope, supported platforms, and non-goals

### In scope

- The environment passed by `runAgy()` to `spawn()`.
- The semantics of `AgyRunOptions.env`.
- Windows case-insensitive environment lookup used by both executable resolution and child-environment construction.
- Ensuring that every real Agy spawn uses an absolute executable path.
- Unit and offline integration tests proving the exact environment handed to the child and an ordinary grandchild.
- Live compatibility and synthetic-canary validation using the official Agy CLI.
- Documentation of the new trust boundary and residual risks.

### Supported platforms for this remediation

The supported `NodeJS.Platform` values are:

```text
win32
linux
darwin
```

`buildAgyChildEnv()` and `runAgy()` must reject every other platform before process creation. AIX, Android, FreeBSD, OpenBSD, SunOS, and other platforms must not be silently treated as Linux. Supporting another platform requires a documented allow-list, unit coverage, and platform-specific live validation. `runAgy()` additionally requires the selected platform to equal the host platform: libuv injection and path semantics follow the actual host, so runner integration is native-host only and a simulated platform string is not runner validation. `options.platform` stays an internal/test hook for that native default; pure cross-platform simulation lives in the `resolveAgyExecutable()`/`buildAgyChildEnv()` helper tests.

Completion is platform-specific. A platform is not considered validated merely because pure tests simulate its string value. If only Windows receives a live compatibility run, Linux and macOS must remain documented as unvalidated rather than being included in an unconditional acceptance claim.

### Out of scope

- Reading, moving, or changing Agy authentication files.
- Injecting provider keys into Agy.
- Changing global Pi environment variables.
- Changing Agy file, URL, command, or model permissions.
- Adding a generic user-configurable environment pass-through.
- Sanitizing child-controlled stdout, stderr, or model output beyond the existing bounds.
- Proving that allow-listed values contain no sensitive path fragments.
- Making command execution safe when the inherited `PATH`, `ComSpec`, or filesystem contains a malicious executable.

A generic `inheritEnv`, `extraEnv`, wildcard, or arbitrary `AGY_*` pass-through must not be added. It would recreate the same disclosure path.

## 4. Design decision

### 4.1 Separate parent-resolution and child environments

The production implementation must preserve the distinction below:

```ts
const parentEnv = options.env ?? process.env;
const platform = options.platform ?? process.platform;
assertSupportedAgyPlatform(platform);
if (platform !== process.platform) { /* fail closed: native-host integration only */ }
const executable = resolveAbsoluteAgyExecutable(parentEnv, platform, options.exists);
const childEnv = buildAgyChildEnv(parentEnv, platform);
spawn(executable, args, { ..., env: childEnv });
```

`parentEnv` may be used only before spawning to resolve the executable and copy named allow-listed runtime variables. It must never be passed to `spawn()` directly.

`AgyRunOptions.env` remains an internal/test injection point, but its meaning changes: it is the **source parent environment** to sanitize, not an exact child-environment override.

`AgyRunOptions.executable` and `spawnImpl` remain test hooks. `options.executable` must be an absolute path for every invocation, including calls that inject a fake `spawnImpl`: a wrapper around the default spawn could still reach the real process, so the absolute requirement is unconditional. Production `executeRole()` must not expose or set `options.executable`.

### 4.2 Own-property lookup and deterministic Windows semantics

All environment reads must use a shared helper with these semantics:

1. Inspect own properties only; inherited properties are ignored.
2. Accept only own data properties whose value is a non-empty string. Accessor properties/getters and `undefined` values are ignored.
3. On Linux/macOS, match the canonical variable name case-sensitively.
4. On Windows, collect own keys that match the canonical name case-insensitively, sort the raw keys using JavaScript's default code-unit ordering, and select the first matching key with a non-empty string data value.
5. Emit only the canonical output spelling from section 5.

This rule defines duplicate-key precedence for injected plain objects and mirrors Node's documented use of deterministic lexicographic handling for duplicate Windows environment names. It must be used consistently for `AGY_CLI_PATH`, `PATH`, `LOCALAPPDATA`, `USERPROFILE`, and every allow-listed Windows variable.

### 4.3 Absolute executable resolution

Executable resolution may inspect unsanitized source values, but it must return an absolute path:

1. Check `AGY_CLI_PATH` using the shared platform-aware lookup.
2. Search `PATH` using the same lookup.
3. On Windows, check the documented `LOCALAPPDATA`/`USERPROFILE` fallback.
4. Resolve every candidate to an absolute path before `exists()` acceptance and before real spawn.
5. If no absolute candidate exists, return the existing bounded `executable_not_found` failure.

This prevents Node's platform-specific command-search fallback from selecting a bare executable through `/usr/bin:/bin` or the current Windows process `PATH` when the sanitized environment lacks `PATH`.

### 4.4 Fresh-object rule

`buildAgyChildEnv()` must start with a fresh object created without inherited properties:

```ts
const childEnv: NodeJS.ProcessEnv = Object.create(null);
```

It must copy only named, non-empty string data values obtained through section 4.2. It must not use object spread, `Object.assign`, mutation of `process.env`, mutation of `parentEnv`, or a delete-after-copy blacklist.

Every helper call and every `runAgy()` invocation must receive a new object identity. The allow-list must be internal and immutable from task/configuration input; no runtime extension point may mutate it.

### 4.5 No credential forwarding

No provider, token, credential, password, secret, proxy, Node preload, Pi, or generic CI variable is allow-listed. In particular, this must exclude names such as:

```text
BAI_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
GOOGLE_API_KEY
GEMINI_API_KEY
AWS_*
AZURE_*
GITHUB_TOKEN
CI
NODE_OPTIONS
NODE_EXTRA_CA_CERTS
NPM_CONFIG_*
PI_*
HTTP_PROXY
HTTPS_PROXY
ALL_PROXY
NO_PROXY
SSL_CERT_FILE
SSL_CERT_DIR
```

This list is a test corpus and documentation aid, not the security mechanism. The allow-list is the security mechanism, so unknown future secret names are also excluded.

Removing variables such as `CI`, locale/time-zone settings, proxy settings, and custom CA paths may change test, authentication, or network behavior. That is an intentional fail-closed compatibility risk. A variable must not be added merely to restore ambient behavior; any addition requires the review process in section 7.

## 5. Child environment allow-list

Only copy a variable when section 4.2 finds it as a non-empty string data value. Do not synthesize a missing value from another environment source.

### 5.1 All supported platforms

| Variable | Reason |
|---|---|
| `PATH` | Allows approved Agy command tools such as `node`, `npm`, and `git` to resolve. The real Agy executable is already resolved to an absolute path before spawn. |

`PATH` is an executable-selection capability and may contain host-identifying path metadata. The runner must never intentionally serialize the source `PATH` value into its own logs, diagnostics, or UI. Raw child stdout/stderr/model output remains untrusted and may independently contain path text; section 7 defines this distinction.

A future path-restriction project may replace `PATH` with a smaller executable-directory list. That is not part of this remediation.

### 5.2 Windows (`win32`)

Copy these variables on Windows only, using the canonical output spelling shown:

```text
PATH
SystemRoot
WINDIR
ComSpec
PATHEXT
TEMP
TMP
USERPROFILE
HOMEDRIVE
HOMEPATH
LOCALAPPDATA
APPDATA
ProgramData
LOGONSERVER
SYSTEMDRIVE
USERDOMAIN
USERNAME
```

Rationale:

- `SystemRoot`/`WINDIR`, `ComSpec`, and `PATHEXT` support normal Windows process and command resolution behavior.
- `TEMP`/`TMP` support temporary files.
- `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `LOCALAPPDATA`, `APPDATA`, and `ProgramData` allow the official CLI to locate its existing login, plugin, and configuration locations without copying credentials through environment variables.
- `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN`, and `USERNAME` are explicitly allow-listed Windows identity metadata, not credentials. The Node/libuv runtime on Windows copies a fixed set of variables (these four plus `HOMEDRIVE`, `HOMEPATH`, `SystemRoot`, `TEMP`, `USERPROFILE`, and `WINDIR`) from ambient `process.env` into any child whose spawn options omit them, below the extension's boundary. Listing all of them keeps every name in the child environment explicit and reviewed instead of silently filled.

These variables are a compatibility allow-list, not a declaration that their values are harmless. Redundant entries should be removed if supported-host validation shows they are unnecessary. A proposed addition or removal requires the evidence process in section 7.

Windows environment keys are case-insensitive. The child environment must contain at most one canonical entry for each allow-listed name and must never contain both variants such as `Path` and `PATH`.

### 5.2.1 Windows required-source rule (unconditional)

On every `runAgy()` invocation whose selected platform is `win32` — regardless of which spawn implementation is injected, because a wrapper around the default spawn could still reach the real process — `runAgy()` must verify, through the shared lookup of section 4.2, that every libuv auto-injected name — `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `SYSTEMDRIVE`, `SystemRoot`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR` — exists as a non-empty own data-property value in the source environment. If any is missing, the run fails before executable resolution and process creation with diagnostics that name only the missing variables. This closes the libuv ambient-source bypass: without the rule, the runtime would fill missing values from ambient `process.env` outside `options.env`, reintroducing variables that the allow-list never approved. Only direct `buildAgyChildEnv()` helper tests may exercise partial win32 source environments; every `runAgy()` fake-spawn test must supply the complete required set.

### 5.3 Linux and macOS (`linux`, `darwin`)

Copy these variables on Linux/macOS only:

```text
PATH
HOME
TMPDIR
TMP
TEMP
XDG_CONFIG_HOME
XDG_DATA_HOME
XDG_CACHE_HOME
USER
LOGNAME
```

The implementation must remain fail-closed: a variable missing from the source remains absent from the child. Locale, time-zone, shell, proxy, custom CA, keyring/DBus, and session-agent variables are not inherited.

`USER` and `LOGNAME` are compatibility candidates rather than credentials. They should remain only if supported-platform validation or documented Agy behavior justifies them.

## 6. Role and command implications

- Every role receives the same sanitized child environment. This avoids a special-case role becoming an environment-secret bypass.
- For an Agy version that executes commands in its sanitized process tree, worker/delegate commands inherit the sanitized environment. An approved `npm test` script therefore cannot obtain parent provider keys through ordinary `process.env` inheritance.
- Command behavior may differ because `CI`, locale, time-zone, proxy, custom CA, and other ambient variables are absent. Command approval must not rely on parent environment variables as security controls.
- Scout/researcher remain commandless by role definition; sanitization is still required because Agy itself is a child trust boundary.
- The runner must not add a role-specific exception for provider authentication. Agy must use its documented local login/configuration mechanism.
- Agy authentication or command execution through a pre-existing environment-bearing daemon is outside the direct spawn proof and must be evaluated by the live synthetic-canary test.

## 7. Failure and diagnostic behavior

The implementation must fail closed.

1. If Agy cannot start or authenticate with the sanitized environment, return the existing bounded spawn/Agy diagnostics.
2. Do not retry with `process.env`, a broader allow-list, or a bare executable name.
3. Do not add a credential variable to the allow-list based solely on an error message.
4. Any new runner-generated environment-dependency diagnostic may identify canonical variable **names** only; it must not serialize `parentEnv`, `childEnv`, or their values.
5. Existing child-controlled stdout, stderr, result errors, and Node spawn errors remain bounded but otherwise verbatim. They may contain executable/configuration paths or other runtime text. Documentation must not claim that all diagnostics are value-free.
6. The parent source object and `process.env` must remain unchanged on success, executable-resolution failure, synchronous spawn failure, asynchronous child failure, timeout, and cancellation.
7. An unsupported platform must fail before executable resolution or spawn.
8. An allow-list addition requires owner approval, a documented non-secret runtime necessity, unit coverage, platform-specific compatibility validation, and a new synthetic-canary run.

The runner must not intentionally log the selected source key or value while resolving duplicate Windows keys. Tests must avoid assertions that print entire environment objects when failing. Every win32 `runAgy()` invocation must fail closed, with names-only diagnostics, when any libuv auto-injected variable (section 5.2.1) is missing from the source environment — regardless of the injected spawn implementation; it must never proceed to any spawn function and let the runtime fill the gap from ambient `process.env`.

## 8. Required implementation shape

### 8.1 Shared environment lookup helper

Add a narrowly scoped internal helper used by both executable resolution and child-environment construction. It must implement section 4.2 and must not expose a task/configuration-controlled extension point.

The helper must be deterministic for plain objects, null-prototype objects, inherited properties, duplicate Windows casings, empty values, and accessor properties.

### 8.2 Child-environment helper

Add a pure exported helper in `src/runner.ts` or a narrowly scoped environment module:

```ts
export function buildAgyChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv
```

Requirements:

- Supports only `win32`, `linux`, and `darwin`; other values throw before spawn.
- Deterministic and side-effect free for the accepted data-object input contract.
- Uses a fresh null-prototype object on every call.
- Uses section 4.2 lookup semantics.
- Copies only the allow-list in section 5.
- Does not expose or consult task/configuration input.
- Does not log or return a diagnostic/redacted representation of environment values.

### 8.3 Runner integration

`runAgy()` must:

1. Select and validate the supported platform, and require it to equal the host platform (`process.platform`); any unsupported or host-mismatched value fails closed before any environment lookup, executable resolution, or process creation. Runner integration is native-host only.
2. On `win32`, enforce the required-source rule of section 5.2.1 for every invocation, regardless of the injected spawn implementation, before executable resolution and spawn.
3. Resolve the real executable to an absolute path using the source environment and platform-aware lookup.
4. Require `options.executable` to be absolute for every invocation, including injected fake spawn implementations.
5. Build `childEnv` once after executable resolution and before `spawn()`.
6. Pass `childEnv` as the exact `spawn()` environment.
7. Never mutate or delete keys from `parentEnv` or `process.env`.
8. Keep `shell: false`, argument-array handling, cancellation, output bounds, and diagnostic classification otherwise unchanged.

## 9. Required tests

### 9.1 Pure helper tests

Use fake values only. Never read, print, snapshot, or deep-diff real host environment values.

1. An input containing allowed variables and fake `BAI_API_KEY`, `OPENAI_API_KEY`, `PI_SESSION_ID`, `NODE_OPTIONS`, `HTTPS_PROXY`, custom CA variables, and an unknown secret produces only allow-listed keys.
2. Secret-name absence is asserted with `Object.hasOwn()`/key lists; a failing assertion must not print fake secret values.
3. The input object, its own keys, descriptors, and values are unchanged.
4. Empty/missing allowed variables are omitted rather than synthesized.
5. Two calls return distinct objects.
6. `Object.getPrototypeOf(result) === null`.
7. Inherited allowed and secret properties are not copied.
8. Accessor/getter properties are ignored without invoking the getter.
9. Windows `Path`, `PATH`, and `path` inputs emit exactly one canonical `PATH` using the section 4.2 precedence.
10. Duplicate Windows variants with different fake values select the documented raw-key ordering deterministically.
11. Every Windows allow-listed name is found under at least one non-canonical casing and emitted once with canonical spelling.
12. Windows does not copy Unix-only variables.
13. Linux and macOS copy only their exact-case allow-lists and exclude Windows-only values.
14. `freebsd`, `aix`, and another representative unsupported platform throw before returning an environment.

### 9.2 Executable-resolution tests

1. Windows lookup observes mixed-case `AGY_CLI_PATH`, `PATH`, `LOCALAPPDATA`, and `USERPROFILE` using the shared precedence rule.
2. Linux/macOS lookup remains case-sensitive.
3. Candidates found through absolute, relative `PATH` entries, and Windows fallback are normalized to an absolute path before acceptance.
4. `AGY_CLI_PATH` itself never appears in the child environment.
5. A non-absolute `options.executable` is rejected before spawn for real/default spawn.
6. A non-absolute `options.executable` is rejected even with an injected fake `spawnImpl`; an absolute sentinel executable remains usable with an injected fake `spawnImpl` for unit tests.
7. Missing `PATH` cannot trigger an ambient Node command-search fallback in a real-spawn code path.
8. A win32 `runAgy()` invocation with missing required source variables fails before spawn with names-only diagnostics (section 5.2.1), including when an injected wrapper spawn implementation is supplied.

### 9.3 Runner integration tests with fake spawn

Runner integration tests always run natively on the host platform; they must not spoof another platform (pure helper/resolver tests keep their platform parameters). Every `runAgy()` fake-spawn test that selects `win32` must supply the complete required source set from section 5.2.1; only direct helper tests (section 9.1) may exercise partial win32 environments. A dedicated regression test must prove the required-source gate and the host-mismatch rejection hold for an injected wrapper `spawnImpl`.

1. `runAgy()` gives fake `spawn()` the sanitized environment, not the supplied source environment.
2. The exact object passed as `spawnOptions.env` is fresh, null-prototype, and not identical to the source or a previous invocation's environment.
3. Executable resolution observes source-only `AGY_CLI_PATH`/`PATH` before sanitization.
4. `AGY_CLI_PATH` and every synthetic secret name are absent from the spawned child environment.
5. Platform rejection occurs before `exists()`, environment construction side effects, or spawn.
6. Frozen or descriptor-snapshotted source objects remain unchanged after success, executable-resolution failure, synchronous spawn throw, asynchronous failure, timeout, abort, and malformed NDJSON.
7. Existing stream, timeout, abort, malformed-NDJSON, and `shell: false` tests remain green.
8. No test fixture contains a real credential or prints a fake credential value on assertion failure.

### 9.4 Offline descendant integration test

Add a no-model fixture that:

1. Starts a real local Node child with `buildAgyChildEnv()` output.
2. Has that child start a grandchild using normal environment inheritance.
3. Gives the source environment a synthetic non-allow-listed canary name.
4. Reports only whether the canary name exists and the sorted allow-listed key names; it never reports environment values.
5. Proves the canary is absent in both child and grandchild.
6. Proves the actual child and grandchild process keys match only the expanded allow-list; there is no accepted runtime-injection exception.

This validates normal operating-system descendant inheritance without involving Agy. It does not replace the official-Agy live canary.

### 9.5 Static and type checks

1. Add a deterministic TypeScript type-check command using the repository's declared compiler/tooling and include it in `npm run check`.
2. Keep the existing static `shell: false`/no-`--sandbox` checks.
3. Add defense-in-depth static checks rejecting direct `env: process.env`, `env: parentEnv`, object-spread environment construction, and delete-after-copy patterns in the runner/environment module.
4. Treat fake-spawn and helper tests—not regex alone—as the authoritative immediate-boundary proof.

### 9.6 Live acceptance tests

Run only after all offline checks pass. Model-backed calls and write-capable worker validation require explicit owner approval.

For each platform claimed as validated, record only OS/version, Node version, Agy version, exit status, tool names, token counts, boolean canary presence, and bounded diagnostics. Never capture, print, or compare real environment values.

1. Using the same helper and resolved absolute executable, verify a non-model official CLI command such as plugin listing works with the sanitized environment.
2. Run one scoped scout read in an approved project root.
3. Run one web-only researcher query without explicit context to confirm local documented authentication still works.
4. In a disposable approved workspace, supply a synthetic source-only variable such as `A04_TEST_CANARY=present` and run one approved worker/delegate command that reports only `Object.hasOwn(process.env, "A04_TEST_CANARY")`. Acceptance requires `false`.
5. Optionally run an already-approved `node --check` compatibility validation after the canary test.
6. Confirm no live path retries with `process.env` after any failure.

The fake-spawn test is authoritative for the immediate environment object passed by this extension. The offline grandchild fixture proves ordinary descendant inheritance. The live synthetic-canary test is authoritative for the tested official Agy version's command-execution path. None of these tests proves that allow-listed values are non-sensitive or that on-disk credentials are inaccessible.

## 10. Documentation changes

Update `README.md`, `docs/architecture.md`, and `docs/permissions.md` to state:

- Agy receives a minimal allow-listed runtime environment on supported/validated platforms.
- Parent provider, generic CI, proxy, custom CA, Node preload, and Pi environment variables are intentionally not inherited.
- Exact standard allow-listed variable **names** may be documented for transparency; never publish an observed host environment inventory or any real values.
- Agy authentication must use its local documented login/configuration mechanism.
- Command behavior may change because `CI`, locale, time-zone, proxy, custom CA, and session variables are absent.
- `PATH`, home, temp, XDG, and Windows profile variables remain trusted metadata/capability channels and may expose path topology.
- Environment isolation does not protect on-disk credentials, malicious executables, child-controlled output, or a pre-existing Agy daemon with an older environment.
- A startup/authentication failure must be fixed by reviewing a named non-secret runtime dependency, never by enabling wholesale inheritance.
- The OS, Node, and Agy versions covered by live validation must be stated; unvalidated platforms must not be presented as accepted.

Do not list real host values or host-specific discovered secret names in public documentation.

## 11. Rollout and secure rollback

1. Implement helper and offline tests first; do not change Agy settings.
2. Add type/static checks and run the complete offline suite before any live Agy call.
3. Perform the approved live compatibility and synthetic-canary checks from section 9.6 for each claimed platform.
4. Commit/release only after all required checks for the claimed platform pass.
5. If compatibility fails before deployment, do not release the isolation change and do not declare A-04 remediated.
6. If compatibility fails after deployment, fail closed by disabling Agy delegation on the affected platform or ship a forward fix with a specifically justified non-secret variable. Do not roll back to a version that forwards `process.env`.
7. A secure rollback may revert to an earlier version only if that version already enforces an equivalent sanitized boundary. Otherwise, rollback means feature disablement, not restoration of ambient inheritance.
8. Never introduce `inheritEnv`, generic `extraEnv`, wildcard pass-through, role-specific credential forwarding, or a retry with the complete parent environment.

## 12. Acceptance criteria

The remediation is complete for a claimed platform only when all conditions hold:

- [ ] The platform is explicitly supported and has the required platform-specific validation evidence.
- [ ] Every real Agy spawn uses an absolute executable path resolved before sanitization.
- [ ] `spawn()` receives a fresh null-prototype allow-listed environment on every Agy invocation.
- [ ] No non-allow-listed source variable reaches the immediate Agy environment, including differently cased Windows names.
- [ ] `options.env` cannot bypass sanitization, and a non-absolute `options.executable` cannot reach spawn at all, including fake-spawn test hooks.
- [ ] Every win32 `runAgy()` invocation — regardless of spawn implementation identity — sources every libuv auto-injected variable from the requested environment; missing names fail before any spawn function runs, with names-only diagnostics.
- [ ] `runAgy()` rejects a selected platform that differs from the host platform before any environment or spawn work; a simulated platform string is not runner validation.
- [ ] Source objects and `process.env` remain unchanged across success and every tested failure/cancellation path.
- [ ] Unsupported platforms fail before process creation without an inheritance fallback.
- [ ] The offline child/grandchild canary test proves ordinary descendant inheritance remains sanitized.
- [ ] Agy resolves, loads its plugin, and completes scoped live calls with the sanitized environment.
- [ ] The approved official-Agy worker/delegate synthetic-canary command reports the non-allow-listed canary name absent.
- [ ] Unit tests, offline integration tests, type checks, static checks, and required live validation pass.
- [ ] Diagnostics documentation distinguishes runner-generated environment diagnostics from verbatim child-controlled output.
- [ ] Public docs describe both the new boundary and residual risks without revealing host values.
- [ ] Rollback and failure procedures remain fail-closed and cannot restore complete `process.env` inheritance.
