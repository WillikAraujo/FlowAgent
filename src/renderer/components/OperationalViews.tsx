import { taskParticipants } from '../hooks/task-participants';
import React from 'react';
import type { ResponsibilityView, WorkspaceAgent, WorkspaceAgentEvent, WorkspaceExecution, WorkspaceNote, WorkspaceTask, WorkspaceWorktree } from '../../shared/contracts/ipc';
import './operational-views.css';

const statusNames: Record<string, string> = {
  created: 'Criado', starting: 'Iniciando', ready: 'Pronto', running: 'Em execução', waiting: 'Aguardando',
  blocked: 'Bloqueado', completed: 'Concluído', succeeded: 'Concluída', failed: 'Falhou', stopped: 'Parado',
  unresponsive: 'Sem resposta', queued: 'Na fila', cancel_requested: 'Cancelando', cancelled: 'Cancelada', interrupted: 'Interrompida',
};
const activeStates = new Set(['created', 'starting', 'ready', 'running', 'waiting', 'blocked', 'queued', 'cancel_requested']);
const attentionStates = new Set(['blocked', 'failed', 'unresponsive', 'interrupted']);
const roleNames: Record<string, string> = { maestro: 'Maestro', planner: 'Planner', developer: 'Desenvolvedor', reviewer: 'Revisor', tester: 'Testes' };
const eventNames: Record<string, string> = {
  'agent.created': 'START', 'agent.starting': 'START', 'agent.started': 'START', 'session.created': 'START', 'session.resumed': 'RESUME',
  'agent.action.started': 'ACTION', 'agent.action.completed': 'RESULT', 'agent.turn.completed': 'RESULT', 'agent.waiting': 'WAIT',
  'agent.completed': 'COMPLETE', 'agent.failed': 'ERROR', 'agent.stopped': 'STOP', 'agent.response': 'RESULT',
  'agent.message.sent': 'MESSAGE', 'agent.message.received': 'MESSAGE', 'provider.protocolError': 'ERROR',
};
const capabilityNames: Record<string, string> = {
  terminal: 'Terminal interativo', shellExecute: 'Executar shell', testExecute: 'Executar testes', streaming: 'Saída em tempo real',
  mcpClient: 'Consumir ferramentas MCP', mcpServer: 'Servir ferramentas MCP', fileEditing: 'Editar arquivos', toolCalling: 'Chamar ferramentas',
  sessionResume: 'Retomar sessão', structuredOutput: 'Saída estruturada', structuredEvents: 'Eventos estruturados', sendMessage: 'Trocar mensagens',
  interrupt: 'Interromper agente', stop: 'Encerrar agente', subagents: 'Criar subagentes',
};

function timeLabel(value?: string | null) {
  if (!value) return 'Horário indisponível';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Horário indisponível' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function durationLabel(start?: string | null, end?: string | null) {
  if (!start) return 'Duração indisponível';
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 'Duração indisponível';
  const seconds = Math.floor((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}min`;
}
function taskTitle(task: WorkspaceTask) { return task.description.trim() || 'Tarefa sem descrição'; }
function shortPath(path: string) { return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path; }
function taskExecutionId(task: WorkspaceTask, executions: WorkspaceExecution[]) {
  return task.runId ?? null;
}
function eventLabel(type: string) { return eventNames[type] ?? type.replace(/[._]/g, ' ').toUpperCase(); }
function eventDetail(event: WorkspaceAgentEvent) {
  const value = event.data.message ?? event.data.action ?? event.data.reason ?? event.data.result ?? event.data.status;
  return value === undefined || value === null ? '' : String(value);
}
function isHumanAttention(event: WorkspaceAgentEvent) {
  return /question|approval[._-]?request|permission[._-]?request|blocked|conflict|review[._-]?required/i.test(event.type);
}

function Status({ value }: { value: string }) {
  return <span className={`op-status status-${value}`}><i />{statusNames[value] ?? value}</span>;
}

export function DashboardView({ projectName, tasks, worktrees, agents, events, executions, onOpenExecution, onNavigate, onStartExecution }: {
  projectName: string; tasks: WorkspaceTask[]; worktrees: WorkspaceWorktree[]; agents: WorkspaceAgent[]; events: WorkspaceAgentEvent[]; executions: WorkspaceExecution[];
  onOpenExecution: (taskId: string) => void; onNavigate: (section: string) => void; onStartExecution: () => void;
}) {
  const activeAgents = agents.filter(agent => ['starting', 'running'].includes(agent.status));
  const waitingAgents = agents.filter(agent => ['waiting', 'blocked'].includes(agent.status));
  const activeTasks = tasks.filter(task => activeStates.has(task.status));
  const recentEvents = [...events].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 8);
  const attentionEvents = events.filter(isHumanAttention).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const attentionAgents = agents.filter(agent => attentionStates.has(agent.status) && !attentionEvents.some(event => event.agentId === agent.agentId));
  return <section className="operational-view dashboard-view">
    <header className="op-page-heading"><div><span className="op-eyebrow">COMMAND CENTER</span><h1>{projectName || 'Projeto'}</h1><p>Execuções, agentes e decisões que precisam de atenção.</p></div><button className="op-primary-action" onClick={onStartExecution}>＋ Nova execução</button></header>
    <div className="op-metrics" aria-label="Resumo do runtime">
      <button onClick={() => onNavigate('Agentes')}><strong>{activeAgents.length}</strong><span>agentes trabalhando</span></button>
      <button onClick={() => onNavigate('Agentes')}><strong>{waitingAgents.length}</strong><span>aguardando ou bloqueados</span></button>
      <button onClick={() => onNavigate('Execuções')}><strong>{activeTasks.length}</strong><span>execuções ativas</span></button>
      <button onClick={() => onNavigate('Worktrees')}><strong>{worktrees.length}</strong><span>worktrees do projeto</span></button>
    </div>
    <div className="op-dashboard-grid">
      <section className="op-surface"><header className="op-section-heading"><div><h2>Event stream</h2><p>Atividade observada no runtime ADE</p></div><button onClick={() => onNavigate('Execuções')}>Ver execuções →</button></header>
        {recentEvents.length ? <ol className="op-activity">{recentEvents.map((event, index) => {
          const task = tasks.find(item => item.taskId === agents.find(agent => agent.agentId === event.agentId)?.taskId);
          const destination = typeof event.data.toAgentId === 'string' ? agents.find(agent => agent.agentId === event.data.toAgentId)?.displayName ?? 'usuário' : null;
          const actor = destination ? `${event.agentName} → ${destination}` : event.agentName;
          return <li key={`${event.agentId}-${event.sequence}-${index}`}>
            <span className={`op-activity-mark ${event.type.includes('failed') || event.type.includes('Error') ? 'danger' : /completed|response/.test(event.type) ? 'success' : ''}`} />
            <time>{timeLabel(event.occurredAt)}</time><div><strong>{actor} <span>{eventLabel(event.type)}</span></strong><p>{eventDetail(event) || roleNames[event.role] || event.providerId}{task ? ` · ${taskTitle(task)}` : ''}</p></div>
          </li>;
        })}</ol> : <div className="op-empty"><strong>Nenhum evento registrado</strong><p>As ações dos agentes aparecem aqui quando uma execução começar.</p><button onClick={onStartExecution}>Iniciar uma execução</button></div>}
      </section>
      <aside className="op-dashboard-side">
        <section className="op-surface"><header className="op-section-heading"><div><h2>Precisa de você</h2><p>Perguntas, aprovações e bloqueios</p></div><span className="op-count">{attentionEvents.length + attentionAgents.length}</span></header>
          {attentionEvents.length || attentionAgents.length ? <div className="op-attention-list">
            {attentionEvents.slice(0, 4).map(event => { const agent = agents.find(item => item.agentId === event.agentId); const taskId = agent?.taskId; return <button key={`${event.agentId}-${event.sequence}`} onClick={() => taskId && onOpenExecution(taskId)}><span className="attention-icon">!</span><span><strong>{agent?.displayName ?? event.agentName}</strong><small>{eventLabel(event.type)}{eventDetail(event) ? ` · ${eventDetail(event)}` : ''}</small></span><b>Abrir →</b></button>; })}
            {attentionAgents.slice(0, Math.max(0, 4 - attentionEvents.length)).map(agent => { const task = tasks.find(item => item.taskId === agent.taskId); return <button key={agent.agentId} onClick={() => task && onOpenExecution(task.taskId)}><span className="attention-icon">!</span><span><strong>{agent.displayName}</strong><small>{statusNames[agent.status]}{task ? ` · ${taskTitle(task)}` : ''}</small></span><b>Abrir →</b></button>; })}
          </div> : <div className="op-clear-state"><span>✓</span><div><strong>Nenhuma ação humana pendente</strong><small>O runtime não reporta perguntas ou bloqueios.</small></div></div>}
        </section>
        <section className="op-surface"><header className="op-section-heading"><div><h2>Execuções ativas</h2><p>Processos trabalhando neste projeto</p></div></header>
          {activeTasks.length ? <div className="op-active-list">{activeTasks.slice(0, 5).map(task => { const members = taskParticipants(agents, executions, task.taskId); return <button key={task.taskId} onClick={() => onOpenExecution(task.taskId)}><strong>{taskTitle(task)}</strong><small>{shortPath(task.worktreePath)} · {members.length} {members.length === 1 ? 'agente' : 'agentes'}</small><Status value={task.status} /></button>; })}</div> : <div className="op-empty compact"><p>Nenhuma execução ativa.</p><button onClick={() => onNavigate('Execuções')}>Ver histórico</button></div>}
        </section>
      </aside>
    </div>
  </section>;
}

export function ExecutionsView({ tasks, agents, events, responsibilities, executions, onOpenExecution, onStartExecution }: {
  tasks: WorkspaceTask[]; agents: WorkspaceAgent[]; events: WorkspaceAgentEvent[]; responsibilities: ResponsibilityView[]; executions: WorkspaceExecution[];
  onOpenExecution: (taskId: string) => void; onStartExecution: () => void;
}) {
  const [filter, setFilter] = React.useState<'all' | 'active' | 'attention' | 'finished'>('all');
  const executionTasks = tasks.filter(task => Boolean(task.runId) || agents.some(agent => agent.taskId === task.taskId) || executions.some(item => item.taskId === task.taskId));
  const sortedTasks = [...executionTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const filteredTasks = sortedTasks.filter(task => {
    const members = taskParticipants(agents, executions, task.taskId);
    const status = members.some(agent => attentionStates.has(agent.status)) ? 'failed' : task.status;
    if (filter === 'active') return activeStates.has(task.status) || members.some(agent => activeStates.has(agent.status));
    if (filter === 'attention') return status === 'failed' || events.some(event => members.some(agent => agent.agentId === event.agentId) && isHumanAttention(event));
    if (filter === 'finished') return !activeStates.has(task.status) && !members.some(agent => activeStates.has(agent.status)) && status !== 'failed';
    return true;
  });
  return <section className="operational-view executions-view">
    <header className="op-page-heading"><div><span className="op-eyebrow">RUNTIME · PROCESSOS</span><h1>Execuções</h1><p>Orquestrações, agentes participantes, dependências e resultados.</p></div><div className="op-execution-toolbar"><label className="op-live-label"><i /> Runtime local</label><select aria-label="Filtrar execuções" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">Todas</option><option value="active">Ativas</option><option value="attention">Precisa de você</option><option value="finished">Concluídas</option></select><button className="op-primary-action" onClick={onStartExecution}>＋ Nova execução</button></div></header>
    {!executionTasks.length ? <div className="op-surface op-empty executions-empty"><strong>Nenhuma execução iniciada</strong><p>Inicie um processo para acompanhar o Maestro, os agentes e os eventos do runtime.</p><button className="op-primary-action" onClick={onStartExecution}>Iniciar execução</button></div> : filteredTasks.length ? <div className="op-execution-list">{filteredTasks.map(task => {
      const members = taskParticipants(agents, executions, task.taskId);
      const memberIds = new Set(members.map(agent => agent.agentId));
      const taskEvents = events.filter(event => memberIds.has(event.agentId)).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
      const taskResponsibilities = responsibilities.filter(item => item.taskId === task.taskId);
      const taskSessions = executions.filter(item => item.taskId === task.taskId);
      const taskAttention = taskEvents.some(isHumanAttention) || members.some(agent => attentionStates.has(agent.status));
      const status = taskAttention ? 'blocked' : task.status;
      const maestro = members.find(agent => agent.role === 'maestro');
      const startedAt = taskSessions.map(item => item.startedAt).filter((value): value is string => Boolean(value)).sort()[0] ?? taskEvents.find(event => ['agent.started', 'session.created'].includes(event.type))?.occurredAt ?? null;
      const progressEvent = taskEvents.find(event => typeof event.data.progress === 'number' || typeof event.data.percent === 'number');
      const rawProgress = progressEvent ? Number(progressEvent.data.progress ?? progressEvent.data.percent) : null;
      const progress = rawProgress === null || !Number.isFinite(rawProgress) ? null : Math.max(0, Math.min(100, rawProgress <= 1 ? rawProgress * 100 : rawProgress));
      const taskId = taskExecutionId(task, executions);
      return <article className="op-execution-card" key={task.taskId}>
        <header className="op-execution-header"><div><span className="op-eyebrow">{taskId ? `EXECUÇÃO · ${taskId.slice(0, 10)}` : 'PROCESSO ASSOCIADO À TAREFA'}</span><h2>{taskTitle(task)}</h2><p>Worktree <code>{shortPath(task.worktreePath)}</code> · {taskSessions.length} sessões de runtime</p></div><div className="op-execution-state"><Status value={status} /><span>{durationLabel(startedAt, taskSessions.every(item => item.finishedAt) && taskSessions.length ? taskSessions.map(item => item.finishedAt).filter(Boolean).sort().at(-1) : null)}</span><button onClick={() => onOpenExecution(task.taskId)}>Abrir execução →</button></div></header>
        {progress === null ? <div className="op-progress-unknown"><span>Progresso não reportado pelo runtime</span></div> : <div className="op-progress-row"><div><span>Progresso observado</span><strong>{Math.round(progress)}%</strong></div><i><b style={{ width: `${progress}%` }} /></i></div>}
        <div className="op-topology" aria-label="Topologia da execução">
          <div className="op-agent-node coordinator"><span className="node-avatar">M</span><div><strong>{maestro?.displayName ?? 'Coordenador do processo'}</strong><small>{maestro ? `Maestro · ${maestro.providerId} · ${statusNames[maestro.status]}` : 'Maestro não reportado pelo runtime'}</small></div>{maestro && <Status value={maestro.status} />}</div>
          <span className="topology-spine" aria-hidden="true" />
          <div className="op-agent-grid">{members.filter(agent => agent.role !== 'maestro').map(agent => {
            const waitsFor = taskResponsibilities.filter(item => item.assignedTo === agent.agentId && item.dependsOn.length && item.status !== 'completed');
            const duration = taskSessions.find(item => item.agentId === agent.agentId)?.startedAt ?? agent.createdAt;
            return <div className={`op-agent-node role-${agent.role}`} key={agent.agentId}><span className={`node-avatar role-${agent.role}`}>{(roleNames[agent.role] ?? agent.role).slice(0, 1)}</span><div><strong>{roleNames[agent.role] ?? agent.role}</strong><small>{agent.displayName} · {agent.providerId} · {durationLabel(duration)}</small>{waitsFor.map(item => <small className="node-dependency" key={item.responsibilityId}>Aguarda: {item.dependsOn.map(id => taskResponsibilities.find(dep => dep.responsibilityId === id)?.title ?? 'outra responsabilidade').join(' + ')}</small>)}</div><Status value={agent.status} /></div>;
          })}{!members.some(agent => agent.role !== 'maestro') && <p className="op-no-workers">Nenhum agente participante associado a esta execução.</p>}</div>
        </div>
        <footer className="op-execution-footer"><span><b>{members.length}</b> agentes</span><span><b>{taskResponsibilities.length}</b> responsabilidades</span>{taskAttention && <span className="active-work-label">Precisa de atenção</span>}{taskEvents[0] && <span>Último evento: {eventLabel(taskEvents[0].type)} · {timeLabel(taskEvents[0].occurredAt)}</span>}{taskEvents[0] && <span className="op-last-event-detail">{eventDetail(taskEvents[0])}</span>}<button onClick={() => onOpenExecution(task.taskId)}>Ver event stream →</button></footer>
      </article>;
    })}</div> : <div className="op-surface op-empty executions-empty"><strong>Nenhuma execução nesta categoria</strong><p>Altere o filtro para ver os outros processos do projeto.</p></div>}
  </section>;
}

type AgentFilter = 'all' | 'active' | 'waiting' | 'blocked' | 'idle' | 'recent';
const agentFilters: { key: AgentFilter; label: string }[] = [
  { key: 'all', label: 'Todos' }, { key: 'active', label: 'Ativos' }, { key: 'waiting', label: 'Aguardando' },
  { key: 'blocked', label: 'Bloqueados' }, { key: 'idle', label: 'Idle' }, { key: 'recent', label: 'Concluídos recentemente' },
];
export function AgentsView({ agents, tasks, executions, events, onOpenAgent }: {
  agents: WorkspaceAgent[]; tasks: WorkspaceTask[]; executions: WorkspaceExecution[]; events: WorkspaceAgentEvent[]; onOpenAgent: (agentId: string) => void;
}) {
  const [filter, setFilter] = React.useState<AgentFilter>('all');
  const visible = agents.filter(agent => {
    if (filter === 'active') return ['starting', 'running'].includes(agent.status);
    if (filter === 'waiting') return agent.status === 'waiting';
    if (filter === 'blocked') return ['blocked', 'failed', 'unresponsive'].includes(agent.status);
    if (filter === 'idle') return ['created', 'ready', 'stopped'].includes(agent.status) && !agent.taskId;
    if (filter === 'recent') return ['completed', 'failed', 'stopped'].includes(agent.status) && Date.now() - Date.parse(agent.updatedAt) < 24 * 60 * 60 * 1000;
    return true;
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return <section className="operational-view agents-view">
    <header className="op-page-heading"><div><span className="op-eyebrow">RUNTIME · PARTICIPANTES</span><h1>Agentes</h1><p>Estado, provider, execução e dependências dos agentes do projeto.</p></div><span className="op-count">{agents.length} agentes</span></header>
    <nav className="op-agent-filters" aria-label="Filtrar agentes">{agentFilters.map(item => <button key={item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>{item.label}</button>)}</nav>
    {visible.length ? <div className="op-agent-list">{visible.map(agent => {
      const task = tasks.find(item => item.taskId === agent.taskId);
      const executionId = task ? taskExecutionId(task, executions) : null;
      const lastEvent = events.filter(item => item.agentId === agent.agentId).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
      const start = executions.find(item => item.agentId === agent.agentId)?.startedAt ?? agent.createdAt;
      return <button className="op-agent-card" key={agent.agentId} onClick={() => onOpenAgent(agent.agentId)}><span className={`node-avatar role-${agent.role}`}>{(roleNames[agent.role] ?? agent.role).slice(0, 1)}</span><span className="op-agent-card-main"><strong>{roleNames[agent.role] ?? agent.role}</strong><small>{agent.displayName} · {agent.providerId}</small><small>{executionId ? `Execução ${executionId.slice(0, 10)}` : 'Sem execução vinculada'} · {task ? taskTitle(task) : 'Sem tarefa vinculada'}</small><small>{shortPath(agent.worktreeId)} · {lastEvent ? `${eventLabel(lastEvent.type)} · ${timeLabel(lastEvent.occurredAt)}` : 'Sem evento recente'}</small></span><span className="op-agent-card-time">{durationLabel(start)}</span><Status value={agent.status} /></button>;
    })}</div> : <div className="op-surface op-empty"><strong>Nenhum agente nesta categoria</strong><p>Os agentes aparecem aqui quando o runtime inicia ou reporta uma sessão.</p></div>}
  </section>;
}

export function AgentDetailView({ agent, agents, tasks, executions, events, responsibilities, onOpenExecution, onBack }: {
  agent: WorkspaceAgent | undefined; agents: WorkspaceAgent[]; tasks: WorkspaceTask[]; executions: WorkspaceExecution[]; events: WorkspaceAgentEvent[];
  responsibilities: ResponsibilityView[]; onOpenExecution: (taskId: string) => void; onBack: () => void;
}) {
  if (!agent) return <section className="operational-view"><header className="op-page-heading"><div><span className="op-eyebrow">RUNTIME · AGENTES</span><h1>Agente indisponível</h1><p>O agente não está mais presente no snapshot atual do runtime.</p></div><button className="op-secondary-action" onClick={onBack}>Voltar aos agentes</button></header></section>;
  const task = tasks.find(item => item.taskId === agent.taskId);
  const session = executions.find(item => item.agentId === agent.agentId && item.taskId === agent.taskId);
  const ownEvents = events.filter(item => item.agentId === agent.agentId).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 8);
  const ownResponsibilities = responsibilities.filter(item => item.taskId === agent.taskId && item.assignedTo === agent.agentId);
  const waitingTitles = ownResponsibilities.flatMap(item => item.dependsOn.map(id => responsibilities.find(dep => dep.responsibilityId === id)?.title ?? id));
  const capabilities = Object.entries(agent.capabilities ?? {});
  return <section className="operational-view agent-detail-view">
    <header className="op-page-heading"><div><span className="op-eyebrow">RUNTIME · AGENTE</span><h1>{roleNames[agent.role] ?? agent.role}</h1><p>{agent.displayName} · {agent.providerId}</p></div><div className="agent-detail-actions"><Status value={agent.status} />{task && <button className="op-primary-action" onClick={() => onOpenExecution(task.taskId)}>Abrir execução →</button>}</div></header>
    <div className="op-agent-detail-grid"><section className="op-surface"><header className="op-section-heading"><div><h2>Contexto</h2><p>Vínculos reportados pelo runtime</p></div></header><dl className="op-agent-facts"><div><dt>Provider</dt><dd>{agent.providerId}</dd></div><div><dt>Execução</dt><dd>{task ? taskExecutionId(task, executions) ?? taskTitle(task) : 'Sem execução'}</dd></div><div><dt>Responsabilidade</dt><dd>{ownResponsibilities.map(item => item.title).join(' · ') || 'Não informada'}</dd></div><div><dt>Worktree</dt><dd>{shortPath(agent.worktreeId)}</dd></div><div><dt>Duração observada</dt><dd>{durationLabel(session?.startedAt ?? agent.createdAt, session?.finishedAt)}</dd></div><div><dt>Dependências</dt><dd>{waitingTitles.length ? `Aguarda ${[...new Set(waitingTitles)].join(' · ')}` : 'Nenhuma dependência reportada'}</dd></div></dl></section>
      <section className="op-surface"><header className="op-section-heading"><div><h2>Capacidades</h2><p>Suporte reportado nesta sessão</p></div></header>{capabilities.length ? <div className="op-agent-capabilities">{capabilities.map(([key, value]) => <div className={`support-${value.support}`} key={key}><span>{value.support === 'supported' ? '✓' : value.support === 'unsupported' ? '×' : value.support === 'conditional' ? '◐' : '?'}</span><strong>{capabilityNames[key] ?? key}</strong><small>{value.reason ?? ({ supported: 'Disponível', unsupported: 'Não disponível', conditional: 'Condicional', unknown: 'Não verificado' } as Record<string, string>)[value.support]}</small></div>)}</div> : <div className="op-empty compact"><p>Capacidades ainda não foram observadas nesta sessão.</p></div>}</section>
    </div>
    <section className="op-surface op-agent-recent"><header className="op-section-heading"><div><h2>Últimas ações</h2><p>Eventos recebidos deste agente</p></div></header>{ownEvents.length ? <ol className="op-activity">{ownEvents.map(event => <li key={`${event.agentId}-${event.sequence}`}><span className={`op-activity-mark ${event.type.includes('failed') ? 'danger' : /completed|response/.test(event.type) ? 'success' : ''}`} /><time>{timeLabel(event.occurredAt)}</time><div><strong>{eventLabel(event.type)}</strong><p>{eventDetail(event) || 'Sem detalhes adicionais no evento.'}</p></div></li>)}</ol> : <div className="op-empty compact"><p>Nenhuma ação registrada.</p></div>}</section>
  </section>;
}

export function SkillsView({ agents }: { agents: WorkspaceAgent[] }) {
  const providers = [...new Set(agents.map(agent => agent.providerId))];
  const keys = Object.keys(capabilityNames);
  return <section className="operational-view catalog-view">
    <header className="op-page-heading"><div><span className="op-eyebrow">PLANEJAMENTO · CAPACIDADES</span><h1>Skills</h1><p>Capacidades do runtime e suporte observado nos providers desta sessão.</p></div></header>
    <section className="op-surface capability-provider"><header className="op-section-heading"><div><h2>Orquestração ADE</h2><p>Ferramentas do runtime disponíveis ao fluxo de agentes</p></div><span className="op-observed-tag">Runtime local</span></header><div className="capability-grid">{[['Criar agentes', 'Maestro autorizado'], ['Enviar mensagens', 'Agentes e usuário'], ['Atribuir responsabilidades', 'Maestro e usuário'], ['Consultar dependências', 'Responsabilidades do projeto'], ['Observar eventos', 'Atividade do runtime']].map(([name, detail]) => <article className="capability-item support-supported" key={name}><span>✓</span><div><strong>{name}</strong><small>{detail}</small></div></article>)}</div></section>
    {!providers.length ? <div className="op-surface op-empty"><strong>Capacidades dos providers ainda não observadas</strong><p>Inicie um agente para consultar o que cada provider reporta nesta sessão.</p></div> : providers.map(providerId => {
      const providerAgents = agents.filter(agent => agent.providerId === providerId);
      const observed = providerAgents.find(agent => agent.capabilities)?.capabilities;
      return <section className="op-surface capability-provider" key={providerId}><header className="op-section-heading"><div><h2>{providerId}</h2><p>{providerAgents.length} {providerAgents.length === 1 ? 'agente observado' : 'agentes observados'}</p></div><span className="op-observed-tag">Dados do runtime</span></header><div className="capability-grid">{keys.map(key => {
        const value = observed?.[key as keyof NonNullable<WorkspaceAgent['capabilities']>];
        const support = value?.support ?? 'unknown';
        return <article className={`capability-item support-${support}`} key={key}><span>{support === 'supported' ? '✓' : support === 'unsupported' ? '×' : support === 'conditional' ? '◐' : '?'}</span><div><strong>{capabilityNames[key]}</strong><small>{support === 'supported' ? 'Disponível' : support === 'unsupported' ? 'Não disponível' : support === 'conditional' ? value?.reason ?? 'Disponível sob condição' : 'Ainda não verificada'}</small></div></article>;
      })}</div></section>;
    })}
    <p className="op-footnote">O catálogo não presume suporte pelo papel. A disponibilidade depende do provider e da sessão observada.</p>
  </section>;
}

export function WorktreesView({ worktrees, agents, tasks, events, onSelect, onOpenExecution }: {
  worktrees: WorkspaceWorktree[]; agents: WorkspaceAgent[]; tasks: WorkspaceTask[]; events: WorkspaceAgentEvent[];
  onSelect: (worktree: WorkspaceWorktree) => void; onOpenExecution: (taskId: string) => void;
}) {
  return <section className="operational-view worktrees-view">
    <header className="op-page-heading"><div><span className="op-eyebrow">RUNTIME · AMBIENTES DE TRABALHO</span><h1>Worktrees</h1><p>Branches vinculadas a agentes e execuções deste projeto.</p></div></header>
    {worktrees.length ? <div className="op-worktree-list">{worktrees.map(tree => {
      const members = agents.filter(agent => agent.worktreeId === tree.branch);
      const branchTasks = tasks.filter(task => task.worktreePath === tree.path);
      const activeTask = branchTasks.find(task => activeStates.has(task.status));
      const blocked = members.some(agent => attentionStates.has(agent.status)) || branchTasks.some(task => task.status === 'failed');
      const inUse = Boolean(activeTask) || members.some(agent => activeStates.has(agent.status));
      const latest = events.filter(event => event.worktreeId === tree.branch).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
      const status = blocked ? 'Bloqueada' : inUse ? 'Em uso' : 'Ociosa';
      return <article className="op-worktree-card" key={tree.path}><header><span className="op-branch-icon">⑂</span><div className="op-worktree-copy"><strong>{tree.branch}{tree.isMain && <i>Principal</i>}</strong><small>{tree.path}</small></div><Status value={blocked ? 'blocked' : inUse ? 'running' : 'stopped'} /></header>
        <dl className="op-worktree-facts"><div><dt>Estado de execução</dt><dd>{status}</dd></div><div><dt>Agentes</dt><dd>{members.length ? members.map(agent => roleNames[agent.role] ?? agent.role).join(' · ') : 'Nenhum agente vinculado'}</dd></div><div><dt>Tarefas ativas</dt><dd>{branchTasks.filter(task => activeStates.has(task.status)).length}</dd></div><div><dt>Último evento</dt><dd>{latest ? `${eventLabel(latest.type)} · ${timeLabel(latest.occurredAt)}` : 'Sem evento reportado'}</dd></div></dl>
        <footer>{activeTask && <button className="op-text-action" onClick={() => onOpenExecution(activeTask.taskId)}>Abrir execução →</button>}<button className="op-text-action" onClick={() => onSelect(tree)}>Ver tarefas desta worktree →</button></footer>
      </article>;
    })}</div> : <div className="op-surface op-empty"><strong>Nenhuma worktree encontrada</strong><p>Abra um projeto Git para listar branches disponíveis.</p></div>}
    <p className="op-footnote">Alterações, commits, testes e conflitos são exibidos quando o runtime fornece esses dados; este snapshot ainda não os informa.</p>
  </section>;
}

export function KnowledgeView({ notes, onCreate }: { notes: WorkspaceNote[]; onCreate: () => void }) {
  return <section className="operational-view">
    <header className="op-page-heading"><div><span className="op-eyebrow">PLANEJAMENTO · MEMÓRIA COMPARTILHADA</span><h1>Conhecimento</h1><p>Decisões e contexto do projeto disponíveis para as próximas execuções.</p></div><button className="op-primary-action" onClick={onCreate}>＋ Nova anotação</button></header>
    {notes.length ? <div className="op-knowledge-list">{notes.map(note => <article className="op-surface op-knowledge-card" key={note.noteId}><span className="knowledge-mark">◇</span><div><h2>{note.title}</h2><p>{note.body || 'Sem conteúdo adicional.'}</p><footer><time>{timeLabel(note.createdAt)}</time>{note.linkedAgentIds?.length ? <span>Referenciada por {note.linkedAgentIds.length} agentes</span> : <span>Conhecimento do projeto</span>}</footer></div></article>)}</div> : <div className="op-surface op-empty"><strong>Nenhuma anotação compartilhada</strong><p>Registre decisões, descobertas e restrições para manter o contexto entre execuções.</p><button className="op-primary-action" onClick={onCreate}>＋ Criar conhecimento</button></div>}
  </section>;
}
