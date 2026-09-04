---
name: agy-scout
description: Read-only local codebase reconnaissance via the Agy scout role. Use when the user asks to scout, inspect, or explore the local codebase read-only; find relevant files, entry points, data flow, risks, or architecture questions. Calls the agy_scout tool; never modifies files.
---

# Agy Scout (read-only)

When the user asks for read-only exploration of the local codebase:

1. Call the `agy_scout` tool with the user's request as `task` and only explicitly relevant `context` or `files`.
2. Never ask it to modify anything; the role is read-only by its tool allow-list.
3. Output is bounded by the extension; report escalation results verbatim.

Do not call `agy_worker`/`agy_delegate` for these requests.

Do not use when the request needs the web; `agy_scout` has no web tools and cannot fetch URLs. No web; for documentation lookups use `agy_researcher`.
