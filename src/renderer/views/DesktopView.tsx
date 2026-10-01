import { taskParticipants } from '../hooks/task-participants';
import React from 'react';
import type { FlowAgentEvent, FlowAgentRunReference, FlowAgentRunSnapshot, ResponsibilityView, WorkspaceAgent, WorkspaceAgentEvent, WorkspaceExecution, WorkspaceNote, WorkspaceProject, WorkspaceTask, WorkspaceWorktree } from '../../shared/contracts/ipc';
import { SettingsPage } from '../components/SettingsPage';
import { CreateTaskDialog, AgentLaunchDialog, Dialog } from '../components/TaskDialogs';
import { MultiAgentPanel } from '../components/MultiAgentPanel';
import { AgentDetailView, AgentsView, DashboardView, ExecutionsView, KnowledgeView, SkillsView, WorktreesView } from '../components/OperationalViews';
import { useRuntimeWorkspace } from '../hooks/useRuntimeWorkspace';
import { useWorkspacePreferences } from '../hooks/useWorkspacePreferences';
import './desktop.css';
import './multi-agent.css';
import '../components/operational-views.css';
import './evolutions.css';

type IconName = 'tasks'|'folder'|'branch'|'clock'|'settings'|'search'|'bell'|'chevron'|'plus'|'paperclip'|'play'|'file'|'note'|'check'|'spark'|'code'|'book'|'swap'|'menu'|'close'|'list'|'alert'|'agents';
const paths: Record<IconName, React.ReactNode> = {
  tasks:<><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 5V3m8 2V3M8 10h8m-8 4h5"/></>,
  folder:<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z"/>,
  branch:<><circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="7" cy="19" r="2"/><path d="M6 7v7a5 5 0 0 0 5 5h-2m9-10a7 7 0 0 1-7 7H6"/></>,
  clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  settings:<><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1m0-14.2L17 7M7 17l-2.1 2.1"/></>,
  search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  bell:<><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 20h4"/></>,
  chevron:<path d="m7 10 5 5 5-5"/>,
  plus:<path d="M12 5v14M5 12h14"/>,
  paperclip:<path d="m9 12 5-5a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/>,
  play:<path d="m7 4 13 8-13 8z"/>,
  file:<><path d="M5 3h9l5 5v13H5zM14 3v5h5M8 13h8m-8 4h8"/></>,
  note:<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8m-8 4h5"/></>,
  check:<path d="m4 12 5 5L20 6"/>,
  spark:<path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/>,
  code:<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>,
  book:<><path d="M12 6c-2-2-5-2-9-1v14c4-1 7-1 9 1 2-2 5-2 9-1V5c-4-1-7-1-9 1zM12 6v14"/></>,
  swap:<path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4"/>,
  menu:<path d="M4 6h16M4 12h16M4 18h16"/>,
  close:<path d="M5 5 19 19M19 5 5 19"/>,
  list:<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>,
  alert:<><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></>,
  agents:<><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v1"/></>,
};
function Icon({name,size=18}: {name:IconName;size?:number}) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>; }
const terminal = new Set(['succeeded','failed','cancelled']);
const stateLabel: Record<string,string> = { queued:'Na fila', running:'Em andamento', cancel_requested:'Cancelando', succeeded:'Concluída', failed:'Falhou', cancelled:'Cancelada', interrupted:'Interrompida' };
function shortPath(path:string) { return path.replace(/\\/g,'/').split('/').filter(Boolean).at(-1) || path; }
function dateLabel(value:string) { return new Date(value).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function elapsedLabel(value:string) { const minutes=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/60_000)); return minutes<1?'há menos de 1 min':`há ${minutes} min`; }
function boardStatus(status:string):'todo'|'doing'|'review'|'done' { if(status==='todo')return 'todo'; if(status==='succeeded')return 'done'; if(status==='failed'||status==='interrupted')return 'review'; if(status==='cancelled')return 'todo'; return 'doing'; }

function OperationalFrame({ error, onDismiss, children }: { error: string; onDismiss: () => void; children: React.ReactNode }) {
  return <div className="operational-stage">{error && <div className="desktop-error" role="alert"><Icon name="alert" size={18} />{error}<button onClick={onDismiss} aria-label="Fechar aviso"><Icon name="close" size={15} /></button></div>}<div className="operational-stage-content">{children}</div></div>;
}

function TaskDetailsPanel({ task, executions, onOpenExecution, onStartExecution, onClose }: {
  task: WorkspaceTask | undefined; executions: WorkspaceExecution[]; onOpenExecution: (taskId: string, executionId?: string) => void; onStartExecution: (taskId: string) => void; onClose: () => void;
}) {
  const related = task ? executions.filter(item => item.taskId === task.taskId) : [];
  const statusLabels: Record<string, string> = { todo: 'A fazer', queued: 'Na fila', running: 'Em andamento', cancel_requested: 'Cancelando', succeeded: 'Concluída', failed: 'Falhou', interrupted: 'Interrompida', cancelled: 'Cancelada' };
  const priorityLabels: Record<string, string> = { low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
  const hasExecution = Boolean(task?.runId || related.length);
  const startedAt = related.map(item => item.startedAt).filter((value): value is string => Boolean(value)).sort()[0];
  return <aside className="right-column task-details-sidebar">
    <header className="task-details-top"><span>PLANEJAMENTO</span><button className="icon-button" onClick={onClose} aria-label="Fechar detalhes"><Icon name="close" size={16} /></button></header>
    {task ? <div className="task-detail-content">
      <span className={`task-state-chip ${task.status}`}><i />{statusLabels[task.status] ?? task.status}</span>
      <h2>{task.description || 'Tarefa sem descrição'}</h2>
      <div className="task-detail-section"><h3>Contexto</h3><p>Organize o trabalho e acompanhe suas execuções relacionadas.</p></div>
      <div className="task-detail-grid">
        <div><span>Prioridade</span><strong>{priorityLabels[task.priority] ?? task.priority}</strong></div>
        <div><span>Impacto</span><strong>{task.impact}</strong></div>
        <div><span>Worktree</span><strong>{task.worktreePath.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? task.worktreePath}</strong></div>
        <div><span>Atualizada</span><strong>{dateLabel(task.updatedAt)}</strong></div>
      </div>
      <section className="task-related-executions">
        <header><h3>Execução da tarefa</h3><button onClick={() => onStartExecution(task.taskId)}>Nova execução</button></header>
        {hasExecution ? <button className="task-related-execution" onClick={() => onOpenExecution(task.taskId, task.runId ?? undefined)}>
          <span className={`execution-state-mark ${task.status}`} />
          <span><strong>{task.runId ? task.runId.slice(0, 10) : 'Processo runtime'}</strong><small>{related.length ? `${related.length} sessões de agentes · ${statusLabels[task.status] ?? task.status}` : statusLabels[task.status] ?? task.status}</small></span>
          <span>{startedAt ? dateLabel(startedAt) : dateLabel(task.updatedAt)}</span><b>Abrir execução</b>
        </button> : <p className="empty-panel">Esta tarefa ainda não possui uma execução.</p>}
      </section>
    </div> : <div className="task-detail-content"><p className="empty-panel">Selecione uma tarefa para ver prioridade, worktree e execuções relacionadas.</p></div>}
  </aside>;
}

export function DesktopView() {
  const api = window.ade;
  const [launchOpen, setLaunchOpen] = React.useState(false);
  const [settingsDirty, setSettingsDirty] = React.useState(false);
  const [pendingSection, setPendingSection] = React.useState<string | null>(null);
  function navigate(next: string) { if (['Providers', 'Integrações', 'Configurações'].includes(section) && settingsDirty && next !== section) setPendingSection(next); else setSection(next); }
  const [selectedAgentId, setSelectedAgentId] = React.useState('');
  const [selectedExecutionId, setSelectedExecutionId] = React.useState('');
  const startAfterCreate = React.useRef(false);

  const [projects,setProjects] = React.useState<WorkspaceProject[]>([]);
  const [projectId,setProjectId] = React.useState('');
  const [worktrees,setWorktrees] = React.useState<WorkspaceWorktree[]>([]);
  const [worktreePath,setWorktreePath] = React.useState('');
  const [tasks,setTasks] = React.useState<WorkspaceTask[]>([]);
  const [notes,setNotes] = React.useState<WorkspaceNote[]>([]);
  const [agents,setAgents] = React.useState<WorkspaceAgent[]>([]);
  const [responsibilities,setResponsibilities] = React.useState<ResponsibilityView[]>([]);
  const [executions,setExecutions] = React.useState<WorkspaceExecution[]>([]);
  const [projectEvents,setProjectEvents] = React.useState<WorkspaceAgentEvent[]>([]);
  const [agentEvents,setAgentEvents] = React.useState<WorkspaceAgentEvent[]>([]);
  const [run,setRun] = React.useState<FlowAgentRunSnapshot|null>(null);
  const [events,setEvents] = React.useState<{label:string; detail:string; time:string; tone:string}[]>([]);
  const [output,setOutput] = React.useState('');
  const [error,setError] = React.useState('');
  const [busy,setBusy] = React.useState(false);
  const [section,setSection] = React.useState('Dashboard');
  const [search,setSearch] = React.useState('');
  const [noteOpen,setNoteOpen] = React.useState(false);
  const [noteTitle,setNoteTitle] = React.useState('');
  const [noteBody,setNoteBody] = React.useState('');
  const [menuOpen,setMenuOpen] = React.useState(false);
  const [sidebarCollapsed,setSidebarCollapsed] = useWorkspacePreferences<boolean>("sidebarCollapsed", false);
  const [rightOpen,setRightOpen] = useWorkspacePreferences<boolean>("rightOpen", false);
  const [selectedTaskId,setSelectedTaskId] = React.useState('');
  const [newTaskOpen,setNewTaskOpen] = React.useState(false);
  const current = React.useRef<FlowAgentRunReference|null>(null);
  const lastSeq = React.useRef(0);
  const selected = projects.find(p=>p.projectId===projectId);
  const worktree = worktrees.find(w=>w.path===worktreePath);
  const active = busy || Boolean(run && !terminal.has(run.state));
  const currentTask = tasks.find(t=>t.taskId===selectedTaskId) ?? tasks.find(t=>t.runId===run?.runId);
  const selectedRun = run && currentTask?.runId === run.runId ? run : null;
  const filteredTasks = tasks.filter(t=>`${t.description} ${t.worktreePath}`.toLowerCase().includes(search.toLowerCase()));

  React.useEffect(()=>{ void api.workspace.listProjects().then(items=>{setProjects(items);setProjectId(previous=>previous || items[0]?.projectId || '');}).catch(e=>setError(String(e))); },[api]);
  React.useEffect(()=>{
    if (!projectId) { setWorktrees([]);setTasks([]);setNotes([]);setAgents([]);setAgentEvents([]);setProjectEvents([]);setExecutions([]);return; }
    let disposed = false;
    setRun(null); setEvents([]); setOutput('');
    void Promise.all([api.workspace.listWorktrees(projectId),api.workspace.listTasks(projectId),api.workspace.listNotes(projectId),api.workspace.listAgents(projectId),api.workspace.listExecutions(projectId)]).then(([trees,items,allNotes,allAgents,allExecutions])=>{
      if (disposed) return;
      setWorktrees(trees); setWorktreePath(previous=>trees.some(t=>t.path===previous)?previous:trees[0]?.path ?? ''); setTasks(items);setNotes(allNotes);setAgents(allAgents);setExecutions(allExecutions);setSelectedTaskId(previous=>items.some(task=>task.taskId===previous)?previous:'');
    }).catch(e=>{ if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  },[api,projectId]);
  React.useEffect(() => {
    if (!projectId) { setResponsibilities([]); return; }
    let disposed = false;
    void api.workspace.listResponsibilities(projectId).then(items => { if (!disposed) setResponsibilities(items); }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [api, projectId, agents.length, agentEvents.length]);
  React.useEffect(() => {
    if (!projectId || !worktrees.length) { setProjectEvents([]); return; }
    let disposed = false;
    void Promise.all(worktrees.map(tree => api.workspace.listAgentEvents(projectId, tree.branch))).then(groups => {
      if (!disposed) setProjectEvents(groups.flat().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 250));
    }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [api, projectId, worktrees, agentEvents.length]);
  const refreshRuntime = useRuntimeWorkspace(projectId, worktree?.branch ?? '', snapshot => { setAgents(snapshot.agents); setAgentEvents(snapshot.events); setTasks(snapshot.tasks); setExecutions(snapshot.executions); }, setError);
  React.useEffect(() => {
    const runId = currentTask?.runId;
    setRun(null); setOutput(''); setEvents([]);
    if (!runId) { current.current = null; return; }
    const reference = { projectId, runId };
    current.current = reference; lastSeq.current = 0;
    let disposed = false;
    void api.flowAgent.getRun(reference).then(async snapshot => {
      if (disposed) return;
      setRun(snapshot);
      await api.flowAgent.subscribe(reference, event => { if (!disposed) onEvent(event); });
      if (disposed) await api.flowAgent.unsubscribe(reference);
    }).catch(() => { /* after restart the normalized persisted history remains available */ });
    return () => { disposed = true; current.current = null; void api.flowAgent.unsubscribe(reference).catch(() => undefined); };
  }, [api, projectId, currentTask?.runId]);
  React.useEffect(()=>()=>{if(current.current)void api.flowAgent.unsubscribe(current.current).catch(()=>undefined);},[api]);
  async function refreshTasks(runId?:string): Promise<WorkspaceTask[]> { if(!projectId) return []; const [items,allAgents,allExecutions]=await Promise.all([api.workspace.listTasks(projectId),api.workspace.listAgents(projectId),api.workspace.listExecutions(projectId)]);setTasks(items);setAgents(allAgents);setExecutions(allExecutions);const created=runId?items.find(item=>item.runId===runId):undefined;if(created)setSelectedTaskId(created.taskId);return items; }
  async function handleExecutionStarted() { const items = await refreshTasks(); const task = items.find(item => item.taskId === selectedTaskId); if (task) { setSelectedExecutionId(task.runId ?? ''); setSection('Execução'); } }
  async function openProject() {
    setError('');
    try {const result=await api.flowAgent.openProject(); if(result.outcome==='opened'){const items=await api.workspace.listProjects();setProjects(items);setProjectId(result.project.projectId);setSection('Dashboard');} else if(result.outcome==='invalid')setError('Selecione a pasta raiz de um repositório Git local.');} catch(e){setError(String(e));}
  }
  async function sendRuntimeMessage(agentIds:string[],message:string) {
    if(!projectId)throw new Error('Projeto indisponível.');
    try { const delivery = await api.agentRuntime.sendMessage({projectId,agentIds,message}); void refreshRuntime(); return delivery; }
    catch(e) { setError(String(e)); throw e; }
  }
  function onEvent(event:FlowAgentEvent) {
    if(!current.current || event.runId!==current.current.runId || event.seq<=lastSeq.current)return;
    lastSeq.current=event.seq;
    const time=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    if(event.type==='run.output')setOutput(v=>(v+event.payload.text).slice(-100_000));
    if(event.type==='run.progress')setEvents(v=>[...v,{label:'Progresso do agente',detail:event.payload.message,time,tone:'info'}]);
    if(event.type==='run.started'){setRun(v=>v&&{...v,state:'running'});setEvents(v=>[...v,{label:'Tarefa iniciada',detail:`Agente ${event.payload.profile==='developer'?'Desenvolvedor':'Revisor'} iniciado.`,time,tone:'success'}]);}
    if(event.type==='run.cancel_requested')setRun(v=>v&&{...v,state:'cancel_requested'});
    if(event.type==='run.completed'||event.type==='run.failed'||event.type==='run.cancelled'){
      setRun(v=>v&&{...v,state:event.payload.status,result:event.payload});
      setEvents(v=>[...v,{label:stateLabel[event.payload.status],detail:'A execução terminou.',time,tone:event.payload.status==='succeeded'?'success':'danger'}]);
      void refreshTasks();
    }
    if(event.type==='run.protocol_error')setError('Não foi possível ler toda a saída do agente.');
  }
  async function cancel() { if(current.current)try{await api.flowAgent.cancel(current.current);}catch(e){setError(String(e));} }
  async function saveNote() {if(!noteTitle.trim()||!projectId)return;try{const note=await api.workspace.saveNote(projectId,noteTitle,noteBody);setNotes(v=>[note,...v]);setNoteTitle('');setNoteBody('');setNoteOpen(false);}catch(e){setError(String(e));}}
  async function toggleChecklist(index:number,checked:boolean) {if(!currentTask)return;try{const updated=await api.workspace.setChecklist(projectId,currentTask.taskId,index,checked);setTasks(v=>v.map(t=>t.taskId===updated.taskId?updated:t));}catch(e){setError(String(e));}}
  const boardTasks = tasks.map(task => ({ id: task.taskId, title: task.description || 'Tarefa sem descrição', description: task.description || 'Sem descrição', tags: [task.profile === 'reviewer' ? 'Revisão' : 'Desenvolvimento'], branch: shortPath(task.worktreePath), status: boardStatus(task.status), duration: ['queued','running','cancel_requested'].includes(task.status) ? elapsedLabel(task.createdAt) : '', agents: taskParticipants(agents, executions, task.taskId).map(agent => `${agent.providerId} · ${agent.role}`).join(', ') || 'Sem agente', source: task }));
  const selectedCard = boardTasks.find(card => card.id === selectedTaskId) ?? null;
  const detailProgress = currentTask && currentTask.checklist.length ? Math.round(currentTask.checklist.filter(Boolean).length / currentTask.checklist.length * 100) : 0;
  const boardColumns = [
    { key: 'todo', title: 'A Fazer', icon: '○' }, { key: 'doing', title: 'Em andamento', icon: '◉' }, { key: 'review', title: 'Em revisão', icon: '◷' }, { key: 'done', title: 'Concluídas', icon: '✓' },
  ];
  const statusLabel: Record<string, string> = { todo: 'A Fazer', doing: 'Em andamento', review: 'Em revisão', done: 'Concluída' };
  const groups = [
    { label: 'Branches do repositório', trees: worktrees },
  ];
  function createTask() { startAfterCreate.current = false; setSection('Tarefas'); setNewTaskOpen(true); }
  function startExecution() { startAfterCreate.current = true; setSection('Tarefas'); setNewTaskOpen(true); }
  function startTaskExecution(taskId: string) {
    const task = tasks.find(item => item.taskId === taskId);
    if (!task) return;
    setSelectedTaskId(task.taskId); setWorktreePath(task.worktreePath); setRightOpen(false); setLaunchOpen(true);
  }
  function openExecution(taskId: string, executionId?: string) {
    const task = tasks.find(item => item.taskId === taskId);
    if (!task) return;
    setSelectedTaskId(taskId);
    setSelectedExecutionId(executionId ?? task.runId ?? '');
    setWorktreePath(task.worktreePath);
    setRightOpen(false);
    setSection('Execução');
  }
  function openAgent(agentId: string) {
    const agent = agents.find(item => item.agentId === agentId);
    if (!agent) return;
    setSelectedAgentId(agentId);
    if (agent.taskId) {
      setSelectedTaskId(agent.taskId);
      const task = tasks.find(item => item.taskId === agent.taskId);
      if (task) setWorktreePath(task.worktreePath);
    }
    setSection('Agente');
  }
  const isSystemSection = ['Providers', 'Integrações', 'Configurações'].includes(section);
  const settingsCategory: 'Geral' | 'Providers' | 'Integrações' = section === 'Providers' ? 'Providers' : section === 'Integrações' ? 'Integrações' : 'Geral';
  const navGroups: { title: string; items: [string, IconName][] }[] = [
    { title: 'VISÃO GERAL', items: [['Dashboard', 'folder']] },
    { title: 'RUNTIME', items: [['Execuções', 'clock'], ['Agentes', 'agents'], ['Worktrees', 'branch']] },
    { title: 'PLANEJAMENTO', items: [['Tarefas', 'tasks'], ['Conhecimento', 'note'], ['Skills', 'spark']] },
    { title: 'SISTEMA', items: [['Providers', 'settings'], ['Integrações', 'settings'], ['Configurações', 'settings']] },
  ];
  return <div className={`ade-desktop ide-layout ${isSystemSection ? 'settings-mode' : ''} ${section !== 'Tarefas' && !isSystemSection ? 'operational-mode' : ''} ${section === 'Execução' || section === 'Agente' ? 'execution-detail-mode' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${rightOpen && section === 'Tarefas' ? '' : 'right-collapsed'}`}>
    <aside className={`desktop-sidebar ${menuOpen ? 'open' : ''}`}>
      <div className="brand-row"><span className="brand-mark">A</span><strong>ADE Desktop</strong><button className="icon-button collapse" onClick={() => setSidebarCollapsed(value => !value)} aria-label="Recolher barra lateral"><Icon name="menu" /></button></div>
      <nav className="main-nav" aria-label="Navegação principal">{navGroups.map(group => <div className="nav-group" key={group.title}><span className="nav-group-title">{group.title}</span>{group.items.map(([label, icon]) => <button key={label} className={`nav-item ${section === label || (label === 'Configurações' && isSystemSection && section === 'Configurações') ? 'selected' : ''}`} aria-current={section === label ? 'page' : undefined} onClick={() => { navigate(label); setMenuOpen(false); }} title={label}><Icon name={icon} /><span>{label}</span>{label === 'Tarefas' && <b>{tasks.length}</b>}</button>)}</div>)}</nav>
      <div className="side-divider" /><div className="side-heading"><span>WORKTREES</span><button className="icon-button" onClick={() => navigate('Worktrees')} aria-label="Ver worktrees"><Icon name="branch" size={15} /></button></div>
      <div className="categorized-worktrees">{groups.map((group, groupIndex) => <section className="worktree-group" key={group.label}><div className="worktree-group-title"><i className={`category-mark category-${groupIndex}`} />{group.label}<span>{group.trees.length}</span></div>{group.trees.map((tree, index) => { const activeTask = tasks.find(task => task.worktreePath === tree.path && ['queued','running','cancel_requested'].includes(task.status)); const runtimeAgents = agents.filter(agent => agent.worktreeId === tree.branch && ['starting','running','waiting'].includes(agent.status)); const runtimeActive = runtimeAgents.some(agent => ['starting','running'].includes(agent.status)); const runtimeWaiting = runtimeAgents.some(agent => agent.status === 'waiting'); const blockedAgent = agents.some(agent => agent.worktreeId === tree.branch && ['blocked','failed','unresponsive'].includes(agent.status)); const blockedTask = tasks.find(task => task.worktreePath === tree.path && task.status === 'failed'); const label = runtimeActive || activeTask ? 'Em execução' : blockedTask || blockedAgent ? 'Bloqueado' : runtimeWaiting ? 'Aguardando' : worktreePath === tree.path ? 'Ativo' : 'Ocioso'; return <button key={tree.path} className={`tree-entry ${worktreePath === tree.path ? 'active' : ''}`} onClick={() => { if (settingsDirty && isSystemSection) { setPendingSection('Tarefas'); return; } setWorktreePath(tree.path); const card = boardTasks.find(item => item.source.worktreePath === tree.path); if (card) setSelectedTaskId(card.id); setSection('Tarefas'); }}><span className={`branch-stripe stripe-${index % 3}`} /><span className="tree-entry-copy"><strong>{tree.branch}</strong><small className={blockedTask || blockedAgent ? 'danger-text' : activeTask || runtimeActive ? 'running-text' : ''}><i />{label}{activeTask ? ' · 1 execução' : ''}</small></span>{runtimeAgents.length > 0 && <span className="tree-agent-count">{runtimeAgents.length}</span>}<span className="tree-more" aria-hidden="true">···</span></button>; })}</section>)}</div>
      <div className="sidebar-footer"><span className="avatar-small">A</span><div><strong>ADE local</strong><small>Runtime de agentes</small></div><button className="icon-button" title="Configurações" onClick={() => navigate('Configurações')}><Icon name="settings" size={16} /></button></div>
    </aside>
      <div className="desktop-main"><header className="desktop-topbar"><button className="icon-button mobile-menu" onClick={() => { if (window.innerWidth <= 760) setMenuOpen(value => !value); else setSidebarCollapsed(value => !value); }} aria-label={sidebarCollapsed ? 'Expandir barra lateral' : 'Recolher barra lateral'}><Icon name="menu" /></button><button className="workspace-switcher" onClick={openProject} disabled={active || settingsDirty} title={settingsDirty ? "Salve ou descarte as configurações antes de trocar de projeto" : "Trocar projeto"}><span className="workspace-glyph">⌂</span><div><small>Projeto atual</small><strong>{selected?.displayName ?? 'Selecione um projeto'} <Icon name="chevron" size={13} /></strong></div></button>{['Tarefas', 'Execução', 'Agente'].includes(section) && <div className="topbar-context"><span className="model-chip"><i /> {agents.find(agent => agent.taskId === currentTask?.taskId)?.providerId ?? 'Runtime ADE'}</span><span className="topbar-divider" /><span className="branch-context"><Icon name="branch" size={15} />{worktree?.branch ?? 'Sem worktree selecionada'}</span></div>}</header>
      {isSystemSection ? <SettingsPage projectId={projectId} projectName={selected?.displayName ?? ''} agents={agents} initialCategory={settingsCategory} onDirtyChange={setSettingsDirty} />
        : section === 'Dashboard' ? <OperationalFrame error={error} onDismiss={() => setError('')}><DashboardView projectName={selected?.displayName ?? ''} tasks={tasks} worktrees={worktrees} agents={agents} events={projectEvents} executions={executions} onOpenExecution={openExecution} onNavigate={navigate} onStartExecution={startExecution} /></OperationalFrame>
        : section === 'Execuções' ? <OperationalFrame error={error} onDismiss={() => setError('')}><ExecutionsView tasks={tasks} agents={agents} events={projectEvents} responsibilities={responsibilities} executions={executions} onOpenExecution={openExecution} onStartExecution={startExecution} /></OperationalFrame>
        : section === 'Agentes' ? <OperationalFrame error={error} onDismiss={() => setError('')}><AgentsView agents={agents} tasks={tasks} executions={executions} events={projectEvents} onOpenAgent={openAgent} /></OperationalFrame>
        : section === 'Agente' ? <OperationalFrame error={error} onDismiss={() => setError('')}><AgentDetailView agent={agents.find(item => item.agentId === selectedAgentId)} agents={agents} tasks={tasks} executions={executions} events={projectEvents} responsibilities={responsibilities} onOpenExecution={openExecution} onBack={() => setSection('Agentes')} /></OperationalFrame>
        : section === 'Execução' ? <section className="execution-detail-shell"><header className="execution-detail-heading"><button className="op-secondary-action" onClick={() => setSection('Execuções')}>← Execuções</button><div><span className="op-eyebrow">RUNTIME · EXECUÇÃO</span><h1>{currentTask?.description || 'Execução indisponível'}</h1><p>{selectedExecutionId ? selectedExecutionId.slice(0, 14) : 'Sem identificador'} · {worktree?.branch ?? 'Worktree indisponível'}</p></div></header>{currentTask ? <MultiAgentPanel key={currentTask.taskId} task={currentTask} worktree={worktree ?? null} run={selectedRun} events={selectedRun ? events : []} output={selectedRun ? output : ''} agents={agents} executions={executions} agentEvents={agentEvents} onSendMessage={sendRuntimeMessage} onOpenAgent={openAgent} onCancel={cancel} onControlAgent={async (agentId, action) => { await api.agentRuntime.control(projectId, agentId, action); await refreshRuntime(); }} /> : <div className="op-surface op-empty"><strong>Execução não encontrada</strong><p>Selecione uma execução vinculada a uma tarefa para abrir seus agentes, eventos e artefatos.</p></div>}</section>
        : section === 'Skills' ? <OperationalFrame error={error} onDismiss={() => setError('')}><SkillsView agents={agents} /></OperationalFrame>
        : section === 'Worktrees' ? <OperationalFrame error={error} onDismiss={() => setError('')}><WorktreesView worktrees={worktrees} agents={agents} tasks={tasks} events={projectEvents} onOpenExecution={openExecution} onSelect={tree => { setWorktreePath(tree.path); setSection('Tarefas'); }} /></OperationalFrame>
        : section === 'Conhecimento' ? <OperationalFrame error={error} onDismiss={() => setError('')}><KnowledgeView notes={notes} onCreate={() => setNoteOpen(true)} /></OperationalFrame>
        : <><div className="ide-content"><section className="kanban-area"><div className="board-toolbar"><div><div className="breadcrumb"><span>Workspace</span><span>›</span><strong>Tarefas</strong></div><h1>Quadro de tarefas</h1><p>Gerencie o trabalho do projeto <strong>{selected?.displayName ?? '—'}</strong><span className="board-updated"><i />{tasks.length ? `Atualizado às ${new Date(Math.max(...tasks.map(task => new Date(task.updatedAt).getTime()))).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}` : 'Sem tarefas registradas'}</span></p></div><div className="board-actions"><label className="board-filter"><Icon name="search" size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filtrar tarefas" /></label>{!rightOpen && <button className="board-view-button" onClick={() => setRightOpen(true)}>◫ <span>Detalhes</span></button>}<button className="start-button compact-start" onClick={createTask}><Icon name="plus" size={16} /> Nova tarefa</button></div></div>
        {error && <div className="desktop-error" role="alert"><Icon name="alert" size={18} />{error}<button onClick={() => setError('')} aria-label="Fechar aviso"><Icon name="close" size={15} /></button></div>}
        <div className="kanban-board">{boardColumns.map(column => {
          const items = boardTasks.filter(card => card.status === column.key && `${card.title} ${card.description} ${card.branch} ${card.tags.join(' ')}`.toLowerCase().includes(search.toLowerCase()));
          return <section className="kanban-column" key={column.key}>
            <header className="kanban-column-header"><div><span className={`column-symbol ${column.key}`}>{column.icon}</span><strong>{column.title}</strong><span className="column-count">{items.length}</span></div><button aria-label={`Adicionar em ${column.title}`} onClick={createTask}>+</button></header>
            <div className="kanban-cards">{items.map(card => <button key={card.id} className={`kanban-task ${selectedTaskId === card.id ? 'selected' : ''}`} onClick={() => { setSelectedTaskId(card.id); setWorktreePath(card.source.worktreePath); setRightOpen(true); }}><span className="task-card-title-row"><strong>{card.title}</strong></span><p>{card.description}</p><span className="task-tags">{card.tags.map(tag => <i key={tag}>{tag}</i>)}</span><span className="task-card-footer"><span className="task-branch"><Icon name="branch" size={13} />{card.branch}</span><span className="task-owner">{card.agents}</span>{card.duration && <span className="task-duration">◷ {card.duration}</span>}</span></button>)}{!items.length && <p className="empty-panel">Nenhuma tarefa registrada nesta coluna.</p>}{column.key === 'doing' && <button className="kanban-add-card" onClick={createTask}>+ Iniciar tarefa</button>}</div>
          </section>;
        })}</div>
        <div className="board-bottom-status"><span><i className="blue-dot" /> {tasks.filter(task => ['queued','running','cancel_requested'].includes(task.status)).length} execuções ativas</span><span>{boardTasks.length} tarefas</span><button onClick={() => setRightOpen(value => !value)}>{rightOpen ? 'Fechar detalhes' : 'Mostrar detalhes'} <span>{rightOpen ? '→' : '←'}</span></button></div>
      </section>
       {rightOpen && <TaskDetailsPanel task={currentTask ?? undefined} executions={executions} onOpenExecution={openExecution} onStartExecution={startTaskExecution} onClose={() => setRightOpen(false)} />}
       </div></>}
     </div>
    {newTaskOpen && <CreateTaskDialog projectId={projectId} worktrees={worktrees} initialPath={worktreePath} onClose={() => { startAfterCreate.current = false; setNewTaskOpen(false); }} onCreated={task => { const shouldLaunch = startAfterCreate.current; startAfterCreate.current = false; setTasks(items => [task, ...items]); setSelectedTaskId(task.taskId); setWorktreePath(task.worktreePath); setNewTaskOpen(false); if (shouldLaunch) setLaunchOpen(true); }} />}
    {launchOpen && currentTask && worktree && <AgentLaunchDialog task={currentTask} worktree={worktree} onClose={() => setLaunchOpen(false)} onLaunched={() => void handleExecutionStarted()} />}
    {pendingSection && <Dialog title="Descartar alterações?" onClose={() => setPendingSection(null)}><p>As configurações ainda não foram salvas.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setPendingSection(null)}>Continuar editando</button><button className="start-button" onClick={() => { setSection(pendingSection); setPendingSection(null); setSettingsDirty(false); }}>Descartar alterações</button></div></Dialog>}
    {noteOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setNoteOpen(false); }}><div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="note-title"><div className="card-title-row"><h2 id="note-title">Nova anotação</h2><button className="icon-button" onClick={() => setNoteOpen(false)} aria-label="Fechar"><Icon name="close" /></button></div><label>Título<input value={noteTitle} maxLength={120} onChange={event => setNoteTitle(event.target.value)} autoFocus /></label><label>Conteúdo<textarea value={noteBody} maxLength={1500} onChange={event => setNoteBody(event.target.value)} /></label><div className="modal-actions"><button className="secondary-button" onClick={() => setNoteOpen(false)}>Cancelar</button><button className="start-button" onClick={saveNote} disabled={!noteTitle.trim()}>Salvar anotação</button></div></div></div>}
  </div>;
}




