# Fleet

A supervisor session runs member agents, each in its own git worktree, and integrates their branches explicitly.

## Language

**Supervisor**:
The primary session that spawns, steers, merges, and cleans members across the fleet.
_Avoid_: Orchestrator, parent, master, controller

**Member**:
An agent working on one branch in its own worktree, registered in the fleet manifest.
_Avoid_: Subagent, worker, child

**Transient member**:
A member whose worktree and manifest entry are removed after it finishes cleanly.
_Avoid_: Ephemeral member, temporary agent

**Clean**:
Removing a member's worktree and manifest entry, and deleting its branch only when that branch is already merged.
_Avoid_: Delete, wipe, purge
