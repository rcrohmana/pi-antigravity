---
name: agy-research-apply
description: Research a topic on the web and then apply the findings to workspace files in one flow via agy_research_apply. Use when the user asks to research/look up/find sources AND then update, write, or revise a file or code with the results.
---

# Agy Research-Apply (composite, write-gated)

When the user's request needs both web research and a workspace edit grounded in it
("research X then update file Y"), call the single `agy_research_apply` tool instead
of chaining `agy_researcher` and `agy_worker` yourself:

1. Split the request into two fields:
   - `question`: the web research part only. Never reference local files, paths, or
     "edit/update the file" instructions here; the researcher has no file tools.
   - `apply_task`: the workspace change to make, naming the file(s) to change. The
     research brief is supplied to this leg automatically as `context`; do not repeat
     the research question here.
2. Optional `context` is forwarded only to the apply leg (never to the researcher) and
   is appended after the research brief.
3. Optional `files` are file-path hints for the apply leg only.
4. Expect exactly one Pi UI confirmation before anything runs, covering both legs; the
   tool is denied without an interactive UI. There is never a second confirmation.
5. The tool runs `agy_researcher` first, then `agy_worker` with the brief. If the
   research leg fails to produce a usable brief (non-success status, an escalation, or
   an empty response), the apply leg is skipped and the result says so.
6. The result reports both legs: a "Research" section and an "Apply" section, each
   bounded by the extension.

Use `agy_researcher` alone for research with no edit, and `agy_worker`/`agy_delegate`
alone for edits that need no web research. Use `agy_research_apply` only when both are
needed in one request; it is not a shortcut for a task that only needs one of the two.
