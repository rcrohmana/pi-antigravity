// A-04 child-environment isolation. This module builds the exact environment
// handed to the Agy child process. It is deliberately narrow:
//
// - The allow-list is the security mechanism. It is internal, immutable, and
//   has no task/configuration extension point; unknown secret names never
//   reach the child by construction.
// - All environment reads go through the shared lookup helper below, which is
//   also used by executable resolution in runner.ts.
// - No helper in this module logs or returns any environment value.

const SUPPORTED_AGY_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze<NodeJS.Platform[]>(["win32", "linux", "darwin"]);

// Windows allow-list (see "Child environment isolation" in
// docs/architecture.md), including the
// owner-approved identity variables LOGONSERVER, SYSTEMDRIVE, USERDOMAIN, and
// USERNAME. Canonical output spellings only; the child must never receive
// duplicate casings.
const WINDOWS_CHILD_ENV_NAMES: readonly string[] = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "USERDOMAIN",
  "USERNAME",
]);

// Section 5.3. Fail closed: a variable missing from the source stays absent.
const UNIX_CHILD_ENV_NAMES: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "USER",
  "LOGNAME",
]);

export function assertSupportedAgyPlatform(platform: NodeJS.Platform): void {
  if (!SUPPORTED_AGY_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported Agy platform "${platform}"; Agy delegation supports only win32, linux, and darwin`);
  }
}

// On win32 the Node/libuv runtime copies exactly these variables from the
// parent process into every spawned child whose spawn options omit them,
// regardless of the environment object handed to spawn(). If any of them is
// missing from the requested source environment, libuv would fill the gap from
// ambient process.env below this module's boundary. Every runAgy() invocation
// on win32 therefore requires every one of these names in the source
// environment, regardless of which spawn implementation is injected; only
// direct buildAgyChildEnv() helper tests may exercise partial win32
// environments.
const REQUIRED_WIN32_SOURCE_ENV_NAMES: readonly string[] = Object.freeze([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "SYSTEMDRIVE",
  "SystemRoot",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

/**
 * Returns the required win32 source-environment names that are absent (or not
 * non-empty string data values) in the source environment. Names only; never
 * values. runAgy() must treat a non-empty result as a pre-spawn failure on
 * every win32 invocation — regardless of the injected spawn implementation —
 * so libuv can never fill missing variables from ambient process.env.
 */
export function missingRequiredWin32SourceEnvNames(parentEnv: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  for (const name of REQUIRED_WIN32_SOURCE_ENV_NAMES) {
    if (lookupEnvironmentValue(parentEnv, name, "win32") === undefined) missing.push(name);
  }
  return missing;
}

/**
 * Spec section 4.2 shared lookup. Own properties only; only own data
 * properties whose value is a non-empty string are accepted. Accessor
 * properties are ignored and their getters are never invoked. Linux/macOS
 * match the canonical name case-sensitively; Windows collects own keys
 * matching the canonical name case-insensitively, sorts the raw keys with
 * JavaScript's default code-unit ordering, and selects the first matching key
 * with a non-empty string data value.
 */
export function lookupEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const matches: string[] = [];
  for (const key of Object.getOwnPropertyNames(env)) {
    if (platform === "win32" ? key.toLowerCase() === name.toLowerCase() : key === name) {
      matches.push(key);
    }
  }
  matches.sort();
  for (const key of matches) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (!descriptor) continue;
    // Data properties only: accessors are skipped without invoking the getter.
    if (descriptor.get !== undefined || descriptor.set !== undefined) continue;
    const value: unknown = descriptor.value;
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Spec section 8.2: pure, side-effect-free child-environment builder. Returns
 * a fresh null-prototype object on every call containing only the allow-listed
 * names found as non-empty string data values in the source environment.
 */
export function buildAgyChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  assertSupportedAgyPlatform(platform);
  const names = platform === "win32" ? WINDOWS_CHILD_ENV_NAMES : UNIX_CHILD_ENV_NAMES;
  const childEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of names) {
    const value = lookupEnvironmentValue(parentEnv, name, platform);
    if (value !== undefined) childEnv[name] = value;
  }
  return childEnv;
}
