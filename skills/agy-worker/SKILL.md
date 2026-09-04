---
name: agy-worker
description: Implementation work via the Agy worker role. Use when the user asks to implement, edit, or fix code in the workspace with delegated agent work; the worker can edit files and run approved validation, gated by a Pi confirmation before writes.
---

# Agy Worker (write-gated)

When the user asks for delegated implementation work:

1. Call the `agy_worker` tool with the bounded request as `task`.
2. Writes require Pi UI confirmation; without a UI the call is denied by design.
3. Commands are limited to approved validation (git status/diff, node --check, npm run check/test) by Agy permission rules.
4. Output is bounded by the extension; report escalation results verbatim.

Prefer `agy_scout` for read-only exploration and `agy_delegate` for lightweight non-edit tasks.

Do not use when the task is web research; `agy_worker` has no web tools. If the task mentions research, web, sources, citations, papers, or URLs, call `agy_researcher` first; worker cannot browse. Do not ask for validation that requires unapproved commands; say "validate by re-reading the file".
