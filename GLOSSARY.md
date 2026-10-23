# Fleet

A supervisor session runs member agents, each in its own git worktree, and integrates their branches explicitly.

## Language

**Supervisor**:
The primary session that owns the fleet and integrates member branches into the repository.
_Avoid_: Orchestrator, parent, master, controller

**Member**:
An agent working on one branch in its own worktree, registered in the fleet manifest.
_Avoid_: Subagent, worker, child

**Clean**:
The removal of a member's worktree and manifest entry, plus its branch when already merged.
_Avoid_: Delete, wipe, purge
