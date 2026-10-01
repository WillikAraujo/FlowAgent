import type { AgentRecord } from '../../domain/agent-provider.ts';

export type AgentAction = 'agent.create' | 'agent.inspect' | 'agent.communicate' | 'note.read' | 'note.write' | 'memory.read' | 'memory.write' | 'decision.read' | 'decision.propose' | 'decision.accept' | 'responsibility.assign' | 'responsibility.read' | 'responsibility.update';

export interface AgentPrincipal {
  id: string;
  kind: 'user' | 'agent' | 'mcp-client';
  projectId: string;
  role: string;
  grants: readonly AgentAction[];
}

export class AgentAccessDeniedError extends Error {
  constructor(message = 'Principal is not authorized for this ADE runtime operation.') {
    super(message);
    this.name = 'AgentAccessDeniedError';
  }
}

/** Central authorization boundary shared by IPC/MCP and runtime services. */
export class AgentAccessPolicy {
  authorize(principal: AgentPrincipal, action: AgentAction, target?: AgentRecord): void {
    if (!principal.id || !principal.projectId || !principal.grants.includes(action)) throw new AgentAccessDeniedError();
    if (target && target.projectId !== principal.projectId) throw new AgentAccessDeniedError('Cross-project access is denied.');
    if ((action === 'agent.create' || action === 'decision.accept') && principal.kind !== 'user' && !(principal.kind === 'agent' && principal.role === 'maestro')) {
      throw new AgentAccessDeniedError(action === 'decision.accept' ? 'Only the user or Maestro can consolidate decisions.' : 'Only a Maestro agent can create another agent.');
    }
    if (action === 'responsibility.assign' && principal.kind !== 'user' && principal.role !== 'maestro') {
      throw new AgentAccessDeniedError('Only the user or Maestro can assign responsibilities.');
    }
  }

  assertSameProject(principal: AgentPrincipal, source: AgentRecord, target: AgentRecord): void {
    if (source.projectId !== principal.projectId || target.projectId !== principal.projectId) {
      throw new AgentAccessDeniedError('Agent communication is limited to the principal project.');
    }
  }
}
