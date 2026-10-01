# Reference board

Created: 2026-09-29
Mode: Operate
Design read: Desktop orchestration workspace for developers, mode Operate, with a quiet IDE and Git client visual lane, dials 4/2/8/3.
Dials: variance 4, motion 2, density 8, art direction 3
Sourcing: viewed via search and fetch on 2026-09-29

## Quality bar
- [Visual Studio Code user interface](https://code.visualstudio.com/docs/editing/getting-started/userinterface): persistent sidebars, a bottom panel with view tabs, and a layout that preserves project context.
- [Linear project views](https://linear.app/docs/projects): tasks can be scanned on a board while project properties remain accessible in context.
- [GitKraken worktrees](https://help.gitkraken.com/gitkraken-desktop/worktrees/): a worktree list can include focused agent-session context and quick status.

## Borrow
- Palette/material: ADE Desktop's existing soft white surfaces, subtle gray dividers, green actions, and role colors stay in place.
- Type/hierarchy: small, direct labels for dense operational data; task title and active agent remain the first scan targets.
- Layout/composition: VS Code's bottom panel model and Linear's task board pattern inform a resizable multi-agent panel under the Kanban.
- Motion/interaction: low-motion interactions; persistent tabs, hideable side panels, and resize affordances expose more workspace without losing task context.
- Asset language: use the existing line icon language and compact role initials; no decorative imagery.

## Avoid
- Replacing the ADE visual identity with a dark editor theme or generic analytics dashboard.
- Raw log walls, private model reasoning, decorative charts, or status colors without labels.

## Direction contract
- Thesis: show the task, worktree, agent handoffs, observable activity, and user controls in one operational workspace.
- First viewport: a compact project header, Kanban board, right task details, and a resizable bottom panel.
- System: existing React and CSS stack; restrained green/blue/amber/red/purple semantics; dense cards and soft separators.
- Risk: at small window sizes the board and agent flow can become cramped; preserve scrolling and keep the panels collapsible.
