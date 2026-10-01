import React from 'react';
import type { WorkspaceAgent, WorkspaceAgentEvent, WorkspaceExecution, WorkspaceTask } from '../../shared/contracts/ipc';
type Snapshot = { agents: WorkspaceAgent[]; events: WorkspaceAgentEvent[]; tasks: WorkspaceTask[]; executions: WorkspaceExecution[] };

/** Refreshes a bounded snapshot when the main-process event bus invalidates it. */
export function useRuntimeWorkspace(projectId: string, worktreeId: string, onSnapshot: (snapshot: Snapshot) => void, onError: (error: string) => void) {
  const context = React.useRef({ projectId, worktreeId, onSnapshot, onError });
  context.current = { projectId, worktreeId, onSnapshot, onError };
  const generation = React.useRef(0);
  const busy = React.useRef(false);
  const pending = React.useRef(false);
  const refresh = React.useCallback(async () => {
    if (busy.current) { pending.current = true; return; }
    const current = context.current;
    if (!current.projectId || !current.worktreeId) return;
    busy.current = true;
    const version = generation.current;
    try {
      const [agents, events, tasks, executions] = await Promise.all([window.ade.workspace.listAgents(current.projectId), window.ade.workspace.listAgentEvents(current.projectId, current.worktreeId), window.ade.workspace.listTasks(current.projectId), window.ade.workspace.listExecutions(current.projectId)]);
      if (version === generation.current) context.current.onSnapshot({ agents, events, tasks, executions });
    } catch (error) { if (version === generation.current) context.current.onError(String(error)); }
    finally { busy.current = false; if (pending.current) { pending.current = false; void refresh(); } }
  }, []);
  React.useEffect(() => {
    generation.current++;
    void refresh();
    return () => { generation.current++; };
  }, [projectId, worktreeId, refresh]);
  React.useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    window.ade.agentRuntime.subscribe(projectId, () => void refresh()).then(stop => {
      if (disposed) stop(); else { unsubscribe = stop; void refresh(); }
    }).catch(error => { if (!disposed) context.current.onError(String(error)); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [projectId, refresh]);
  return refresh;
}
