---
name: agy-researcher
description: Web and documentation research via the Agy researcher role. Use when the user asks to research a question, look up official documentation, or gather cited web sources read-only; calls the agy_researcher tool and never modifies files.
---

# Agy Researcher (read-only)

When the user asks for research with cited sources:

1. Call the `agy_researcher` tool with the question as `task`.
2. Web-only: no local-file, edit, or command tools. Web access is limited by Agy allow rules; do not supply file hints.
3. Require cited URLs in the result; report escalation results verbatim.
4. Output is bounded by the extension.

Do not use for local code inspection (`agy_scout` covers that).

Do not use when the task also requires reading or editing a workspace file; `agy_researcher` has no file tools and cannot touch the filesystem.

Research then edit: if the user also wants a file updated, do two steps: call `agy_researcher`, then call `agy_worker` with the brief as `context` and the edit instruction as `task`. Never put file-edit instructions in the researcher task.
