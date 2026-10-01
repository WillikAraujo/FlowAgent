import React from 'react';
import type { WorkspaceAgent, WorkspaceTask } from '../../shared/contracts/ipc';
import type { CollaborationMessage, KnowledgeRecord } from '../../domain/collaboration';
import type { DomainEvent } from '../../domain/model';
import type { CollaborationCommand } from '../../shared/contracts/collaboration';

const stateLabels: Record<string,string> = { ACTIVE:'Ativa',ACKNOWLEDGED:'Recebida',RESOLVED:'Resolvida',SUPERSEDED:'Substituída',ARCHIVED:'Arquivada',proposed:'Proposta',accepted:'Aceita',rejected:'Rejeitada',superseded:'Substituída',archived:'Arquivada',queued:'Na fila',delivered:'Entregue',responded:'Respondida',timed_out:'Prazo encerrado',cancelled:'Cancelada',failed:'Falhou',delivery_uncertain:'Entrega incerta' };
const eventLabels:Record<string,string> = { 'agent.ask.created':'Pergunta criada','agent.ask.delivered':'Pergunta entregue','agent.reply.created':'Resposta recebida','agent.ask.timed_out':'Prazo da pergunta encerrado','agent.ask.cancelled':'Pergunta cancelada','agent.ask.failed':'Entrega falhou','agent.reply.rejected':'Resposta rejeitada','note.created':'Nota criada','note.acknowledged':'Nota recebida','note.resolved':'Nota resolvida','decision.proposed':'Decisão proposta','decision.accepted':'Decisão aceita','context.selected':'Contexto selecionado','agent.message.delivery.started':'Entrega iniciada','agent.message.created':'Mensagem criada','agent.message.delivered':'Mensagem entregue','agent.ask.interrupted':'Pergunta interrompida','agent.started':'Execu\u00e7\u00e3o iniciada','agent.completed':'Execu\u00e7\u00e3o conclu\u00edda','agent.failed':'Execu\u00e7\u00e3o falhou','agent.stopped':'Agente encerrado','agent.waiting':'Agente aguardando','agent.turn.completed':'Turno conclu\u00eddo','responsibility.assigned':'Responsabilidade atribu\u00edda','responsibility.status.changed':'Responsabilidade atualizada','note.updated':'Nota atualizada','note.archived':'Nota arquivada','memory.created':'Mem\u00f3ria registrada' };

export function CollaborationPanel({task,agents}:{task:WorkspaceTask;agents:WorkspaceAgent[]}) {
  const [events,setEvents] = React.useState<DomainEvent[]>([]);
  const [knowledge,setKnowledge] = React.useState<KnowledgeRecord[]>([]);
  const [cursor,setCursor] = React.useState(0);
  const [latest,setLatest] = React.useState(0);
  const [nextId,setNextId] = React.useState<string|null>(null);
  const [interaction,setInteraction] = React.useState<CollaborationMessage|null>(null);
  const [error,setError] = React.useState('');
  const [busy,setBusy] = React.useState(false);
  const [loaded,setLoaded] = React.useState(false);
  const [kind,setKind] = React.useState<'note'|'memory'|'decision'>('note');
  const [target,setTarget] = React.useState('');
  const [title,setTitle] = React.useState('');
  const [body,setBody] = React.useState('');
  const [filter,setFilter] = React.useState<'all'|'ask'|'note'|'decision'>('all');
  const name = (id:string) => id === 'user' || id === 'local-user' ? 'Você' : agents.find(a => a.agentId === id)?.displayName ?? id;
  const mounted = React.useRef(true);
  const projectId = task.projectId;
  async function load(reset=false, afterId?:string) {
    const [history,items] = await Promise.all([
      window.ade.collaboration.query({projectId,kind:'history',taskId:task.taskId,cursor:reset ? 0 : cursor,limit:100}),
      window.ade.collaboration.query({projectId,kind:'knowledge',taskId:task.taskId,afterId,limit:50}),
    ]);
    if (!mounted.current) return;
    if (history.resync) { setEvents([]); setCursor(0); } else {
      setEvents(previous => [...new Map([...(reset ? [] : previous),...history.events].map(e => [e.eventId,e])).values()].sort((a,b) => a.sequence-b.sequence));
      setCursor(history.nextCursor);
    }
    setLatest(history.latestSequence);
    setKnowledge(previous => reset ? items.knowledge : [...new Map([...previous,...items.knowledge].map(item=>[item.id,item])).values()]); setNextId(items.nextId); setLoaded(true);
  }
  React.useEffect(() => {
    mounted.current=true; setEvents([]);setKnowledge([]);setCursor(0);setLoaded(false);setInteraction(null);
    void load(true).catch(e => { if(mounted.current)setError(String(e)); });
    return () => { mounted.current=false; };
  },[task.taskId]);
  // The existing project subscription broadcasts committed activity. Keep this view current without restarting its history cursor.
  React.useEffect(() => {
    let disposed=false;
    const timer=setInterval(() => { if(!disposed) void load().catch(e => {if(!disposed)setError(String(e));}); },2000);
    return () => {disposed=true;clearInterval(timer);};
  },[task.taskId,cursor]);
  React.useEffect(() => {
    if (!interaction) return;
    let disposed=false;
    const timer=setInterval(() => {
      void window.ade.collaboration.query({projectId,kind:'interaction',messageId:interaction.messageId})
        .then(page => {if(!disposed && page.messages[0])setInteraction(page.messages[0]);})
        .catch(e => {if(!disposed)setError(String(e));});
    },2000);
    return () => {disposed=true;clearInterval(timer);};
  },[projectId,interaction?.messageId]);
  async function command(input:CollaborationCommand) {
    setBusy(true);setError('');
    try { await window.ade.collaboration.command(input); await load(); } catch(e){setError(String(e));} finally{setBusy(false);}
  }
  async function create(event:React.FormEvent) {
    event.preventDefault();
    if(!title.trim() || !body.trim()) {setError('Informe título e conteúdo.');return;}
    if(kind === 'memory' && !target) {setError('Selecione o agente dono da memória.');return;}
    setBusy(true);setError('');
    try {
      await window.ade.collaboration.command({projectId,action:'create',kind,input:{title,body,scope:kind === 'decision' || !target ? 'project' : 'agent',...(kind === 'memory' ? {ownerAgentId:target} : target ? {targetAgentIds:[target]} : {}),relations:[{type:'task',id:task.taskId}]}});
      setTitle('');setBody('');await load();
    } catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function open(event:DomainEvent) {
    if(event.entityType !== 'message') return;
    setError('');
    try {const page=await window.ade.collaboration.query({projectId,kind:'interaction',messageId:event.entityId});if(mounted.current)setInteraction(page.messages[0] ?? null);}catch(e){setError(String(e));}
  }
  const visible=events.filter(e => filter === 'all' || (filter === 'ask' ? e.entityType === 'message' : e.entityType === filter));
  return <section className="collaboration-panel" aria-label="Colaboração entre agentes">
    <header><h2>Colaboração</h2><p>Perguntas, notas e decisões da tarefa, com origem e histórico.</p></header>
    {error && <p role="alert">{error}</p>}
    {!loaded && !error && <p role="status">Carregando interações…</p>}
    <nav className="activity-filters" aria-label="Filtrar colaboração">{([['all','Todos'],['ask','Perguntas'],['note','Notas'],['decision','Decisões']] as const).map(([key,label])=><button key={key} aria-pressed={filter===key} className={filter===key?'active':''} onClick={()=>setFilter(key)}>{label}</button>)}</nav>
    <section className="agent-flow" aria-label="Fluxo de colaboração">{events.filter(e=>['agent.ask.created','agent.reply.created','note.created'].includes(e.type)).map(e=><article key={e.eventId}><strong>{name(String(e.payload.fromAgentId ?? e.payload.authorId))}</strong><span>{e.type==='note.created'?'NOTE':e.type==='agent.reply.created'?'REPLY':'ASK'} → {e.type==='note.created' ? (Array.isArray(e.payload.targetAgentIds) ? e.payload.targetAgentIds.map(id=>name(String(id))).join(', ') || 'Projeto' : 'Projeto') : name(String(e.payload.toAgentId))}</span></article>)}</section>
    <div className="collaboration-history">{visible.map(event=><article key={event.eventId}><time>{new Date(event.occurredAt).toLocaleTimeString('pt-BR')}</time><div><strong>{name(String(event.payload.authorId ?? event.payload.agentId ?? 'system'))} · {eventLabels[event.type] ?? event.type}</strong><p>{event.payload.toAgentId ? `→ ${name(String(event.payload.toAgentId))}` : String(event.payload.title ?? '')}</p>{event.entityType === 'message' && <button className="quiet-button" onClick={()=>void open(event)}>Abrir interação</button>}</div></article>)}{loaded && !visible.length && <p>Nenhuma interação neste filtro.</p>}</div>
    {cursor<latest && <button className="secondary-button" disabled={busy} onClick={()=>void load().catch(e=>setError(String(e)))}>Carregar mais histórico</button>}
    {interaction && <section className="op-surface collaboration-detail" aria-label="Detalhes da interação"><header><h3>{name(interaction.fromAgentId)} → {name(interaction.toAgentId)}</h3><button className="quiet-button" onClick={()=>setInteraction(null)}>Fechar detalhes</button></header><p>{stateLabels[interaction.state] ?? interaction.state}</p><dl><dt>Pergunta</dt><dd>{interaction.message}</dd><dt>Resposta</dt><dd>{interaction.response ?? 'Aguardando resposta explícita.'}</dd><dt>Execução de origem</dt><dd>{interaction.sourceExecutionId ?? 'Mensagem do usuário'}</dd><dt>Execução de destino</dt><dd>{interaction.targetExecutionId ?? 'Ainda não entregue'}</dd><dt>Criada em</dt><dd>{new Date(interaction.sentAt).toLocaleString('pt-BR')}</dd><dt>Prazo</dt><dd>{new Date(interaction.deadline).toLocaleString('pt-BR')}</dd><dt>Contexto e arquivos</dt><dd>{interaction.contextRefs.length ? interaction.contextRefs.map(ref=><p key={`${ref.type}:${ref.id}`}>{ref.type}: {ref.id} {ref.worktreeId && `(${ref.worktreeId})`}</p>) : 'Nenhuma referência adicional.'}</dd></dl>{interaction.failure&&<p role="status">{interaction.failure}</p>}</section>}
    <h3>Conhecimento relacionado</h3><div className="collaboration-knowledge">{knowledge.map(item=><article className="op-surface" key={item.id}><strong>{item.title}</strong><p>{item.body}</p><small>{item.kind} · {stateLabels[item.status]} · {name(item.authorId)} · revisão {item.revision}</small><p>{item.targetAgentIds.length ? `Para ${item.targetAgentIds.map(name).join(', ')}` : item.ownerAgentId ? `Memória de ${name(item.ownerAgentId)}` : 'Projeto'}</p>{item.kind === 'decision' && item.status === 'proposed' && <button className="secondary-button" disabled={busy} onClick={()=>void command({projectId,action:'transition',kind:'decision',id:item.id,expectedRevision:item.revision,transition:'accept',justification:'Aceita pelo usuário após consultar a proposta no ADE.'})}>Aceitar decisão</button>}{!['ARCHIVED','archived'].includes(item.status) && <button className="quiet-button" disabled={busy} onClick={()=>void command({projectId,action:'transition',kind:item.kind,id:item.id,expectedRevision:item.revision,transition:'archive'})}>Arquivar</button>}</article>)}{loaded && !knowledge.length && <p>Nenhum conhecimento relacionado registrado.</p>}</div>
    {nextId && <button className="secondary-button" disabled={busy} onClick={()=>void load(false,nextId).catch(e=>setError(String(e)))}>Carregar mais conhecimento</button>}
    <details><summary>Registrar conhecimento</summary><form onSubmit={create}><label>Tipo<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="note">Nota</option><option value="memory">Memória individual</option><option value="decision">Proposta de decisão</option></select></label>{kind !== 'decision' && <label>{kind === 'memory'?'Dono da memória':'Destinatário'}<select value={target} onChange={e=>setTarget(e.target.value)}><option value="">{kind==='memory'?'Selecionar agente':'Projeto'}</option>{agents.map(a=><option key={a.agentId} value={a.agentId}>{a.displayName} · {a.providerId}</option>)}</select></label>}<label>Título<input value={title} onChange={e=>setTitle(e.target.value)} maxLength={120} required /></label><label>Conteúdo<textarea value={body} onChange={e=>setBody(e.target.value)} maxLength={1500} required /></label><button className="start-button" disabled={busy}>{busy?'Salvando…':'Registrar'}</button></form></details>
  </section>;
}
