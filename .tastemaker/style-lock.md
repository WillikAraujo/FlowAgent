# ADE Desktop style lock

Updated: 2026-09-29

## Direction
- Surface: desktop-first development orchestration workspace.
- Keep the existing ADE light theme, typography, rounded cards, subtle shadows, soft dividers, and green primary actions.
- Use blue for active execution, amber for waiting and review, red for errors and conflicts, and purple for planning.
- Keep information density high while preserving clear labels, readable task descriptions, and visible worktree context.
- Use an IDE-like bottom panel for task, multi-agent, files, logs, and terminal views. Let the user collapse, expand, and resize it.
- Show observable actions, decisions, handoffs, artifacts, results, errors, and messages. Do not expose private model reasoning.
- Keep motion quiet and short; status should be communicated in text as well as color.

## Structure
- Dashboard answers what is happening now; Tasks retains the full Kanban workflow.
- Executions is a first-class view grouped by task, with coordinator, agents, provider, worktree, status, dependencies, activity, and results.
- Keep the task detail sidebar and resizable IDE-style activity panel contextual to Tasks; collapse them when no task or execution needs attention.
- Multi-agent flow derives its dependency edges from runtime responsibility data so it supports parallel workers.
- Reference field: `.tastemaker/reference-board.md`.
