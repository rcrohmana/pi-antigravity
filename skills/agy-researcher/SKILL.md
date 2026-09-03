---
name: agy-researcher
description: Web and documentation research via the Agy researcher role. Use when the user asks to research a question, look up official documentation, or gather cited web sources read-only; calls the agy_researcher tool and never modifies files.
---

# Agy Researcher (read-only)

When the user asks for research with cited sources:

1. Call the `agy_researcher` tool with the question as `task`.
2. Read-only: no file edits, no command execution; web access is limited by Agy allow rules.
3. Require cited URLs in the result; report escalation results verbatim.
4. Output is bounded by the extension.

Do not use for local code inspection (`agy_scout` covers that).
