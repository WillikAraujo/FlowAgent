import type { AgentFixture, AgentRowProjection, CapabilityState, DetectionResult, SectionFixture, TaskFixture } from '../mocks/operationalList.fixtures';
import { StateMessage } from './SectionListContent';

type AgentDirectoryProps = {
  agents: SectionFixture<AgentFixture>;
  detectionResult: DetectionResult;
  rows: AgentRowProjection[];
  tasks: TaskFixture[];
};

export function AgentDirectory({ agents, detectionResult, rows, tasks }: AgentDirectoryProps) {
  switch (agents.state) {
    case 'loading':
      return <StateMessage title="Carregando agentes" message={agents.message ?? 'A leitura de agentes está em andamento.'} tone="pending" />;
    case 'error':
      return <StateMessage title="Falha na leitura de agentes" message={agents.message ?? 'Não foi possível carregar agentes.'} reasons={agents.reasons} tone="error" />;
    case 'empty':
      return <EmptyAgents detectionResult={detectionResult} section={agents} />;
    case 'partial':
      return <>
        <StateMessage title="Lista parcial de agentes" message={agents.message ?? 'Alguns dados de agentes não estão disponíveis.'} reasons={agents.reasons} metadata={agents} tone="partial" />
        {agents.items.length > 0
          ? <AgentRows agents={agents.items} rows={rows} tasks={tasks} />
          : <p className="no-valid-rows">Nenhum item válido de agente foi recebido neste resultado parcial.</p>}
      </>;
    case 'stale':
      return <>
        <StateMessage title="Snapshot de agentes desatualizado" message={agents.message ?? 'Mostrando os itens do último snapshot identificado.'} reasons={agents.reasons} metadata={agents} tone="stale" />
        {agents.items.length > 0
          ? <AgentRows agents={agents.items} rows={rows} tasks={tasks} />
          : <p className="no-valid-rows">O snapshot identificado não contém itens de agente.</p>}
      </>;
    case 'ready':
      return agents.items.length > 0
        ? <AgentRows agents={agents.items} rows={rows} tasks={tasks} />
        : <EmptyAgents detectionResult={detectionResult} section={agents} />;
  }
}

function EmptyAgents({ detectionResult, section }: { detectionResult: DetectionResult; section: SectionFixture<AgentFixture> }) {
  if (detectionResult === 'absent') {
    return <StateMessage
      title="Nenhuma sessão qualificada encontrada"
      message={section.message ?? 'A checagem foi concluída sem sessão CLI local autenticada e disponível.'}
      reasons={section.reasons}
      tone="empty"
    />;
  }

  if (detectionResult === 'present') {
    return <StateMessage
      title="Snapshot de agentes inconsistente"
      message="A checagem confirmou uma sessão qualificável, mas este snapshot vazio não contém o agente correspondente. Atualize a leitura."
      reasons={section.reasons}
      tone="stale"
    />;
  }

  return <StateMessage
    title="Lista de agentes vazia; detecção desconhecida"
    message={section.message ?? 'Nenhum agente foi retornado, mas a detecção não foi confirmada.'}
    reasons={section.reasons}
    tone="empty"
  />;
}

function AgentRows({ agents, rows, tasks }: { agents: AgentFixture[]; rows: AgentRowProjection[]; tasks: TaskFixture[] }) {
  const rowsByAgentId = new Map(rows.map((row) => [row.agentEntityId, row]));
  const tasksById = new Map(tasks.map((task) => [task.entityId, task]));

  return <ul className="agent-list">
    {agents.map((agent) => {
      const row = rowsByAgentId.get(agent.entityId);
      const taskLabel = row?.task.state === 'none'
        ? 'Sem tarefa'
        : row?.task.state === 'linked'
          ? tasksById.get(row.task.taskEntityId)?.title ?? 'Tarefa vinculada'
          : 'Tarefa não informada';

      return <li className="agent-row" key={agent.entityId}>
        <div className="agent-primary">
          <span className="agent-avatar" aria-hidden="true">{agent.displayName.slice(0, 1).toUpperCase()}</span>
          <div className="agent-identity"><strong>{agent.displayName}</strong><span>{agent.adapterId}</span></div>
          <span className={`detection-result detection-${row?.detectionResult ?? 'unknown'}`}>{detectionLabel(row?.detectionResult ?? 'unknown')}</span>
          <div className="agent-task"><span>TAREFA</span><strong>{taskLabel}</strong></div>
        </div>
        <div className="agent-secondary">
          <span>Atividade: {row?.activity.state === 'known' ? row.activity.value : 'Não informada'}</span>
          <span>Papel: {row?.role.state === 'known' ? row.role.value : 'Não informado'}</span>
        </div>
        <div className="agent-capabilities">
          <span>Saúde: {row?.health.state === 'known' ? row.health.value : 'Não informada'}</span>
          <div className="capability-list">
            {Object.entries(agent.capabilityStates).map(([name, state]) => <Capability key={name} name={name} state={state} />)}
          </div>
        </div>
      </li>;
    })}
  </ul>;
}

function detectionLabel(result: AgentRowProjection['detectionResult']) {
  if (result === 'present') return 'Sessão confirmada';
  if (result === 'absent') return 'Sem sessão qualificada';
  return 'Detecção desconhecida';
}

function Capability({ name, state }: { name: string; state: CapabilityState }) {
  const label = state === 'supported' ? 'Suportada' : state === 'unsupported' ? 'Não suportada' : 'Desconhecida';
  return <span className={`capability capability-${state}`}>{name}: {label}</span>;
}
