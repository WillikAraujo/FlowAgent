import type { WorkspaceAgent, WorkspaceExecution } from '../../shared/contracts/ipc';

/** Historical participation belongs to executions, not the agent's current task pointer. */
export function taskParticipants(agents:WorkspaceAgent[], executions:WorkspaceExecution[], taskId:string):WorkspaceAgent[] {
  return agents.flatMap(agent=>{
    const execution=executions.filter(e=>e.agentId===agent.agentId && e.taskId===taskId).sort((a,b)=>(b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
    if (!execution) return agent.taskId===taskId ? [agent] : [];
    const current=execution.sessionId===agent.activeSessionId && agent.taskId===taskId;
    return [{...agent,taskId,worktreeId:execution.worktreeId ?? agent.worktreeId,status:execution.status as WorkspaceAgent['status'],
      capabilities:current ? agent.capabilities : agent.capabilities ? {...agent.capabilities,sendMessage:{support:'unsupported' as const,reason:'Esta participação pertence a uma execução anterior.'},interrupt:{support:'unsupported' as const},stop:{support:'unsupported' as const},sessionResume:{support:'unsupported' as const}} : undefined}];
  });
}
