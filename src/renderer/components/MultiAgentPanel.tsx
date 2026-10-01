import { AgentMessage } from './AgentMessage';
import { AgentArtifacts } from './AgentArtifacts';
import { AgentFlow } from './AgentFlow';
import { CollaborationPanel } from './CollaborationPanel';
import { taskParticipants } from '../hooks/task-participants';
import React from 'react';
import type { FlowAgentRunSnapshot, WorkspaceAgent, WorkspaceAgentEvent, WorkspaceTask, WorkspaceWorktree, MessageDelivery, ResponsibilityView } from '../../shared/contracts/ipc';

type PanelTab = 'Visão geral' | 'Agentes' | 'Arquivos' | 'Event stream' | 'Saída' | 'Colaboração';
type ActivityEvent = { id?: string; label: string; detail: string; time: string; tone: string; type?: string };
const tabs: PanelTab[] = ['Event stream', 'Colaboração', 'Agentes', 'Arquivos', 'Saída', 'Visão geral'];
const runLabels: Record<string, string> = {
  queued: 'Na fila', running: 'Em andamento', cancel_requested: 'Cancelando',
  succeeded: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada',
};

function taskStatus(task: WorkspaceTask | null, run: FlowAgentRunSnapshot | null) {
  return run ? runLabels[run.state] : task ? (runLabels[task.status] ?? task.status) : 'Sem execução';
}

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="runtime-empty-state"><strong>{title}</strong><p>{children}</p></div>;
}

function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  if (!events.length) return <EmptyState title="Nenhum evento disponível">O backend não forneceu eventos para esta execução.</EmptyState>;
  return <div className="agent-timeline">{events.map((event, index) => <article className="agent-event" key={event.id ?? `${event.time}-${index}`}>
    <span className={`event-icon ${event.tone}`}>{event.tone === 'success' ? '✓' : event.tone === 'danger' ? '!' : '↗'}</span>
    <time>{event.time}</time><div><strong>{event.label}</strong><p>{event.detail}</p></div>
  </article>)}</div>;
}

const agentStatusLabels: Record<WorkspaceAgent['status'], string> = {
  created: 'Criado', starting: 'Iniciando', ready: 'Pronto', running: 'Executando', waiting: 'Aguardando',
  blocked: 'Bloqueado', completed: 'Concluído', failed: 'Falhou', stopped: 'Parado', unresponsive: 'Sem resposta',
};

export function MultiAgentPanel({ task, worktree, run, events, output, agents, agentEvents, executions = [], onSendMessage, onCancel, onControlAgent, onOpenAgent }: {
  executions?: import('../../shared/contracts/ipc').WorkspaceExecution[];
  task: WorkspaceTask | null;
  worktree: WorkspaceWorktree | null;
  run: FlowAgentRunSnapshot | null;
  events: ActivityEvent[];
  output: string;
  agents: WorkspaceAgent[];
  agentEvents: WorkspaceAgentEvent[];
  onSendMessage: (agentIds: string[], message: string) => Promise<MessageDelivery>;
  onControlAgent: (agentId: string, action: 'interrupt' | 'stop' | 'resume') => Promise<void>;
  onOpenAgent: (agentId: string) => void;
  onCancel: () => void;
}) {
  const [responsibilities, setResponsibilities] = React.useState<ResponsibilityView[]>([]);
  React.useEffect(() => { let disposed = false; if(task) void window.ade.workspace.listResponsibilities(task.projectId).then(items => { if(!disposed) setResponsibilities(items.filter(item=>item.taskId===task.taskId)); }).catch(error=>{if(!disposed)setPanelError(String(error));}); return()=>{disposed=true;}; }, [task?.taskId, agentEvents.length]);
  const [activeTab, setActiveTab] = React.useState<PanelTab>('Event stream');
  const [draft,setDraft] = React.useState(() => localStorage.getItem(`ade.draft.${task?.taskId ?? 'none'}`) ?? '');
  React.useEffect(() => { localStorage.setItem(`ade.draft.${task?.taskId ?? 'none'}`, draft); }, [draft, task?.taskId]);
  const [panelError, setPanelError] = React.useState('');
  const [retryTargets, setRetryTargets] = React.useState<string[] | null>(null);
  const [recipient,setRecipient] = React.useState('all');
  const [sending,setSending] = React.useState(false);
  const [eventFilter,setEventFilter] = React.useState<'all'|'questions'|'blocks'|'results'>('all');
  const canCancel = run && !['succeeded', 'failed', 'cancelled'].includes(run.state);
  const branch = worktree?.branch ?? (task ? task.worktreePath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) : null);
  const participants = task ? taskParticipants(agents,executions,task.taskId).filter(agent=>agent.worktreeId===branch) : [];
  const roleLabels: Record<string, string> = { maestro: 'Maestro', planner: 'Planner', developer: 'Developer', reviewer: 'Reviewer', tester: 'Tester' };
  const lead = participants.find(agent => agent.role === 'maestro') ?? participants[0];
  const label = lead ? `${lead.providerId} · ${roleLabels[lead.role] ?? lead.role}` : task?.profile === 'reviewer' ? 'Codex · Revisor' : 'Codex · Desenvolvedor';
  const participantIds = new Set(participants.map(agent=>agent.agentId));
  const taskSessions = new Set(executions.filter(e=>e.taskId===task?.taskId).map(e=>e.sessionId));
  const sessionEvents = agentEvents.filter(event=>participantIds.has(event.agentId) && (!taskSessions.size || (!!event.sessionId && taskSessions.has(event.sessionId))));
  const eventLabels: Record<string,string> = {
    'agent.created':'Agente criado','agent.starting':'Agente iniciando','agent.started':'Agente iniciou a tarefa',
    'agent.action.started':'Agente iniciou uma ação','agent.action.completed':'Ação concluída','agent.turn.completed':'Turno concluído',
    'agent.waiting':'Agente aguardando','agent.completed':'Agente concluído','agent.failed':'Agente falhou',
    'agent.stopped':'Agente parado','agent.response':'Resposta do agente','agent.message.sent':'Mensagem enviada','agent.message.received':'Mensagem recebida',
    'session.created':'Sessao do provider criada','session.resumed':'Sessao retomada','provider.protocolError':'Erro de protocolo',
  };
  const runtimeTimeline = sessionEvents.map(event=>{
    const detail = event.type === 'agent.message.sent' || event.type === 'agent.message.received' || event.type === 'agent.response'
      ? String(event.data.message ?? '')
      : String(event.data.action ?? event.data.reason ?? event.data.stopReason ?? '');
    return { id: `${event.agentId}-${event.sequence}`, type:event.type, label:`${event.agentName} · ${eventLabels[event.type] ?? event.type}`, detail, time:new Date(event.occurredAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}), tone:event.type==='agent.failed'||event.type==='provider.protocolError'?'danger':event.type==='agent.completed'||event.type==='agent.action.completed'?'success':'running' };
  });
  const timeline = runtimeTimeline.length ? runtimeTimeline : events;
  const visibleTimeline = eventFilter === 'all' ? timeline : runtimeTimeline.filter(event => eventFilter === 'questions' ? /message|response/i.test(event.type ?? '') && /\?|question/i.test(event.detail) : eventFilter === 'blocks' ? /waiting|blocked|failed|unresponsive/i.test(event.type ?? '') : /completed|result|artifact/i.test(event.type ?? ''));
  const messages = sessionEvents.filter(event=>event.type==='agent.response'||(event.type==='agent.message.sent'&&event.data.fromAgentId===event.agentId)||(event.type==='agent.message.received'&&event.data.fromAgentId==='user'));
  async function sendMessage(){
    const targets=retryTargets ?? (recipient==='all'?participants.filter(agent=>agent.capabilities?.sendMessage?.support==='supported').map(agent=>agent.agentId):participants.filter(agent=>agent.agentId===recipient&&agent.capabilities?.sendMessage?.support==='supported').map(agent=>agent.agentId));
    if(!draft.trim()||!targets.length||sending)return;
    if(targets.length>10){setPanelError('Escolha até 10 destinatários por envio.');return;}
    setSending(true); setPanelError('');
    try { const delivery = await onSendMessage(targets,draft.trim()); const failed = delivery.results.filter(item=>!item.sent); if(failed.length){setRetryTargets(failed.map(item=>item.agentId));setPanelError(`${delivery.sent} mensagem(ns) entregue(s). ${failed.map(item=>item.error).join('; ')} Tentar novamente envia apenas aos destinatários que falharam.`);}else{setDraft('');setRetryTargets(null);} } catch(error){setPanelError(String(error));} finally{setSending(false);}

  }

  return <section className="multi-agent-panel execution-runtime-panel">
    <div className="panel-tabs-row">
      <nav className="bottom-panel-tabs" aria-label="Seções da execução">{tabs.map(tab => <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{tab}</button>)}</nav>
    </div>
      {activeTab === 'Visão geral' && <div className="session-details-tab">
        {task ? <><div className="details-summary"><div><span>ESTADO DA TAREFA</span><strong>{task.description || 'Tarefa sem descrição'}</strong><p>{label}</p></div><span className="session-status blue"><i />{taskStatus(task, run)}</span></div>
          <div className="detail-metadata"><div><small>Worktree</small><strong>{branch ?? 'Não informada'}</strong></div><div><small>Criada em</small><strong>{new Date(task.createdAt).toLocaleString('pt-BR')}</strong></div><div><small>Atualizada em</small><strong>{new Date(task.updatedAt).toLocaleString('pt-BR')}</strong></div><div><small>Checklist</small><strong>{task.checklist.filter(Boolean).length} / {task.checklist.length} concluídos</strong></div></div>
        </> : <EmptyState title="Nenhuma tarefa selecionada">Selecione uma tarefa para consultar os dados disponíveis do workspace.</EmptyState>}
      </div>}
      {activeTab === 'Agentes' && <div className="multi-agent-view">
        <div className="session-main-column">
          <header className="agent-session-header"><div><div className="session-eyebrow"><span className="session-status blue"><i />{participants.some(agent=>agent.status==='running')?'Em execução':participants.some(agent=>agent.status==='waiting')?'Aguardando instrução':taskStatus(task, run)}</span><span>·</span><span>{label}</span></div><h2>Execução da tarefa</h2><p>{task?.description || 'Nenhuma tarefa selecionada'} {branch && <><span>›</span> <code>{branch}</code></>}</p></div>
            {canCancel && <div className="session-controls"><button className="agent-action-more" onClick={onCancel}>Cancelar execução</button></div>}
          </header>
          <section className="participants-block"><div className="subsection-heading"><div><strong>Participantes da execução</strong><span>Provider, papel e estado reportado pelo runtime</span></div></div>
            {participants.length ? <div className="runtime-participants">{participants.map(agent=><article key={agent.agentId} className={`runtime-participant ${agent.status==='failed'||agent.status==='blocked'?'danger':agent.status==='running'?'running':''}`}><span className="runtime-participant-icon">{agent.providerId==='opencode'?'O':'C'}</span><div><strong>{roleLabels[agent.role]??agent.role}</strong><small>{agent.providerId} · {agent.worktreeId}</small></div><span className="runtime-participant-status">{agentStatusLabels[agent.status]}</span><div className="participant-actions"><button className="quiet-button" onClick={()=>onOpenAgent(agent.agentId)}>Abrir agente</button>{(['interrupt','stop','resume'] as const).filter(action=>agent.capabilities?.[action==='resume'?'sessionResume':action]?.support==='supported' && (action!=='stop'||!['completed','failed','stopped'].includes(agent.status))).map(action=><button className="quiet-button" key={action} disabled={sending} onClick={async()=>{setSending(true);setPanelError('');try{await onControlAgent(agent.agentId,action);}catch(error){setPanelError(String(error));}finally{setSending(false);}}}>{action==='interrupt'?'Interromper':action==='stop'?'Encerrar':'Retomar'}</button>)}</div></article>)}</div> : <EmptyState title="Nenhum agente nesta tarefa">Inicie uma execução nos detalhes da tarefa ou selecione outra tarefa para consultar participantes reais do runtime.</EmptyState>}
          </section>
          <AgentFlow responsibilities={responsibilities} agents={participants} />
        </div>
        <details className="agent-messages-disclosure"><summary>Mensagens dos agentes · {messages.length}</summary><section className="agent-conversation"><header className="conversation-header"><div><strong>Mensagens</strong><span>Conversa secundária da execução</span></div></header>
          <div className="conversation-stream">{messages.length?messages.map(event=>{const fromUser=event.data.fromAgentId==='user';const target=agents.find(agent=>agent.agentId===event.data.toAgentId);return <AgentMessage key={`${event.agentId}-${event.sequence}`} event={event} targetName={fromUser?event.agentName:event.data.toAgentId==='user'?'você':target?.displayName??String(event.data.toAgentId??'agente')} />}):<EmptyState title="Sem mensagens de agentes">O runtime ainda nao registrou mensagens entre agentes nesta worktree.</EmptyState>}</div>
          <footer className="agent-composer"><select aria-label="Destinatario" value={recipient} onChange={event=>{setRecipient(event.target.value);setRetryTargets(null);}}><option value="all">Todos os agentes aguardando</option>{participants.map(agent=><option key={agent.agentId} value={agent.agentId}>{roleLabels[agent.role]??agent.role} · {agent.providerId}</option>)}</select><textarea aria-label="Mensagem para os agentes" placeholder="Mensagem para os agentes..." maxLength={8000} value={draft} onChange={event=>{setDraft(event.target.value);setRetryTargets(null);}} onKeyDown={event=>{if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();void sendMessage();}}} /><button className="start-button compact-start" onClick={()=>void sendMessage()} disabled={!draft.trim()||sending||!(recipient==='all'?participants.some(agent=>agent.capabilities?.sendMessage?.support==='supported'):participants.some(agent=>agent.agentId===recipient&&agent.capabilities?.sendMessage?.support==='supported'))}>{sending?'Enviando...':'Enviar'}</button><small>Ctrl + Enter para enviar</small>{panelError&&<p role="alert">{panelError}</p>}</footer>
        </section></details>
      </div>}
      {activeTab === 'Arquivos' && (task && branch ? <AgentArtifacts projectId={task.projectId} worktreeId={branch} /> : <EmptyState title="Selecione uma tarefa">Arquivos e diffs pertencem a uma worktree.</EmptyState>)}
      {activeTab === 'Colaboração' && (task ? <CollaborationPanel key={task.taskId} task={task} agents={agents} /> : <EmptyState title="Selecione uma tarefa">Interações e conhecimento pertencem a um projeto e uma tarefa.</EmptyState>)}
      {activeTab === 'Event stream' && <div className="execution-event-stream"><header><div><strong>Event stream da execução</strong><span>Eventos estruturados recebidos do runtime ADE</span></div></header><nav className="activity-filters" aria-label="Filtrar eventos">{([['all','Todos'],['questions','Perguntas'],['blocks','Bloqueios'],['results','Resultados']] as const).map(([key,label])=><button key={key} className={eventFilter===key?'active':''} onClick={()=>setEventFilter(key)}>{label}</button>)}</nav><ActivityTimeline events={visibleTimeline} /></div>}
      {activeTab === 'Saída' && <div className="terminal-panel"><div><span className="terminal-dot" /><strong>Saída capturada do agente</strong><code>{branch ?? 'Sem worktree'}</code><span className="terminal-live">{run ? taskStatus(task, run) : 'Sem execução em memória'}</span></div>
        {output || sessionEvents.some(event=>event.type==='agent.response') ? <pre>{output || sessionEvents.filter(event=>event.type==='agent.response').map(event=>`${event.agentName}: ${event.data.message}`).join('\n\n')}</pre> : <EmptyState title="Nenhuma saída disponível">A execução usa saída capturada do processo; ela não abre um terminal interativo nesta versão.</EmptyState>}
      </div>}
  </section>;
}
