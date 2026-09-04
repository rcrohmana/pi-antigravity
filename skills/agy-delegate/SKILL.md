---
name: agy-delegate
description: Lightweight bounded delegation via the Agy delegate role. Use when the user asks to delegate a bounded, general-purpose task to the delegated agent without nested orchestration; write-capable and gated by a Pi confirmation before writes.
---

# Agy Delegate (write-gated)

When the user asks to delegate a bounded general-purpose task:

1. Call the `agy_delegate` tool with the bounded request as `task`.
2. Writes require Pi UI confirmation; without a UI the call is denied by design.
3. No nested agent spawning; keep the task close to the parent request.
4. Output is bounded by the extension; report escalation results verbatim.

Prefer `agy_scout` for read-only exploration and `agy_worker` for implementation work.

Do not use when the task is web research; `agy_delegate` has no web tools. If the task mentions research, web, sources, citations, papers, or URLs, call `agy_researcher` first; delegate cannot browse. Do not ask for validation that requires unapproved commands; say "validate by re-reading the file".
