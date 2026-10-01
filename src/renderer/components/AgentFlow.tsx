import React from 'react';
import type { ResponsibilityView, WorkspaceAgent } from '../../shared/contracts/ipc';
export function AgentFlow({ responsibilities, agents }: { responsibilities: ResponsibilityView[]; agents: WorkspaceAgent[] }) {
  if (!responsibilities.length) return <p className="empty-panel">Nenhuma dependência registrada. Os participantes não possuem uma ordem implícita de execução.</p>;
  return <section className="agent-flow" aria-label="Dependências da execução">{responsibilities.map(item => <article key={item.responsibilityId}><strong>{item.title}</strong><span>{agents.find(agent => agent.agentId === item.assignedTo)?.displayName ?? 'Sem responsável'} · {item.status}</span><small>{item.dependsOn.length ? `Aguarda: ${item.dependsOn.map(id => responsibilities.find(dependency => dependency.responsibilityId === id)?.title ?? id).join(', ')}` : 'Sem dependências'}</small></article>)}</section>;
}
