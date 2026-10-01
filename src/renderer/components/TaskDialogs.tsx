import React from 'react';
import type { WorkspaceTask, WorkspaceWorktree, WorkspaceAgent } from '../../shared/contracts/ipc';
import type { ProviderAvailability } from '../../shared/settings';

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const desktop = document.querySelector<HTMLElement>('.desktop-main');
    const sidebar = document.querySelector<HTMLElement>('.desktop-sidebar');
    if (desktop) desktop.inert = true;
    if (sidebar) sidebar.inert = true;
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    return () => { if (desktop) desktop.inert = false; if (sidebar) sidebar.inert = false; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div ref={ref} className="modal-card new-task-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const elements = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])];
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div className="card-title-row"><h2 id={titleId}>{title}</h2><button className="secondary-button" onClick={onClose}>Fechar</button></div>{children}</div></div>;
}

export function CreateTaskDialog({ projectId, worktrees, initialPath, onClose, onCreated }: { projectId: string; worktrees: WorkspaceWorktree[]; initialPath: string; onClose: () => void; onCreated: (task: WorkspaceTask) => void }) {
  const [description, setDescription] = React.useState('');
  const [path, setPath] = React.useState(initialPath);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  async function save() {
    if (!description.trim() || !path) { setError('Descreva a tarefa e selecione uma worktree.'); return; }
    setBusy(true); setError('');
    try { onCreated(await window.ade.workspace.createTask({ projectId, worktreePath: path, description, profile: 'developer' })); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  return <Dialog title="Nova tarefa" onClose={() => { if (!busy) onClose(); }}><p>Registre o trabalho. Você escolhe os agentes antes de iniciar.</p><label>Descrição<textarea value={description} maxLength={700} onChange={event => setDescription(event.target.value)} aria-invalid={!!error} /></label><label>Worktree<select value={path} onChange={event => setPath(event.target.value)}><option value="">Selecionar worktree</option>{worktrees.map(tree => <option key={tree.path} value={tree.path}>{tree.branch}</option>)}</select></label>{error && <p role="alert">{error}</p>}<div className="modal-actions"><button className="start-button" disabled={busy} onClick={() => void save()}>{busy ? 'Salvando…' : 'Criar tarefa'}</button></div></Dialog>;
}

export function AgentLaunchDialog({ task, worktree, onClose, onLaunched }: { task: WorkspaceTask; worktree: WorkspaceWorktree; onClose: () => void; onLaunched: () => void }) {
  const [providers, setProviders] = React.useState<ProviderAvailability[]>([]);
  const [existingAgents,setExistingAgents] = React.useState<WorkspaceAgent[]>([]);
  const [members, setMembers] = React.useState<{ providerId: string; role: string; agentId?: string; reuseAgentId?: string; displayName?: string; specialties?: string }[]>([{ providerId: 'codex', role: 'developer' }]);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    let disposed = false;
    Promise.all([window.ade.inspectProviders(), window.ade.loadSettings(), window.ade.workspace.listAgents(task.projectId)]).then(([providers, settings, agents]) => {
      if (disposed) return;
      setExistingAgents(agents); setProviders(providers); setMembers([{ providerId: settings.projectProviders[task.projectId] ?? settings.defaultProvider, role: 'developer' }]);
    }).catch(error => { if (!disposed) setError(String(error)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [task.projectId]);
  async function start() {
    if (members.some(member => !member.agentId && providers.find(provider => provider.providerId === member.providerId)?.status !== 'available')) { setError('Verifique a instalação dos providers selecionados em Configurações.'); return; }
    setBusy(true); setError('');
    const updated = [...members];
    try {
      for (let index = 0; index < updated.length; index++) {
        const member = updated[index];
        if (member.agentId) continue;
        const agent = await window.ade.agentRuntime.launchAgent({ projectId: task.projectId, taskId: task.taskId, worktreeId: worktree.branch, providerId: member.providerId, role: member.role, task: task.description, agentId: member.reuseAgentId, displayName: member.displayName, specialties: member.specialties?.split(',').map(s => s.trim()).filter(Boolean) });
        updated[index] = { ...member, agentId: agent.agentId }; setMembers([...updated]);
      }
      onLaunched(); onClose();
    } catch (error) { setError(`${String(error)} Agentes já iniciados foram preservados; tentar novamente inicia apenas os restantes.`); onLaunched(); }
    finally { setBusy(false); }
  }
  const providerLimitations = members.filter(member => member.providerId === 'opencode' && ['developer', 'tester', 'maestro'].includes(member.role));
  return <Dialog title="Iniciar execução" onClose={() => { if (!busy) onClose(); }}><p>{task.description}</p><p><strong>Worktree:</strong> {worktree.branch}</p><p>Equipe manual: cada participante recebe a tarefa. Coordenação automática depende de um Maestro autorizado.</p>{providerLimitations.length > 0 && <div className="launch-capability-warning" role="status"><strong>Limitações do OpenCode nesta execução</strong><p>O adapter atual não oferece execução de shell nem de testes. Papéis Developer, Tester e Maestro não conseguem executar comandos por esse provider.</p><small>Troque o provider do participante para um que ofereça essas capacidades se a tarefa depender de testes.</small></div>}{members.map((member, index) => <div key={index} className="launch-member"><label>Identidade<select disabled={busy || !!member.agentId} value={member.reuseAgentId ?? ''} onChange={event=>{const existing=existingAgents.find(a=>a.agentId===event.target.value);setMembers(members.map((item,i)=>i===index ? {...item,reuseAgentId:existing?.agentId,providerId:existing?.providerId ?? item.providerId,role:existing?.role ?? item.role} : item));}}><option value="">Novo agente</option>{existingAgents.filter(a=>['completed','failed','stopped','unresponsive'].includes(a.status)).map(a=><option key={a.agentId} value={a.agentId}>{a.displayName} · {a.providerId}</option>)}</select></label>{!member.reuseAgentId && <><label>Nome<input disabled={busy || !!member.agentId} maxLength={120} value={member.displayName ?? ''} placeholder="Nome do agente" onChange={e=>setMembers(members.map((item,i)=>i===index?{...item,displayName:e.target.value}:item))} /></label><label>Especialidades<input disabled={busy || !!member.agentId} maxLength={600} value={member.specialties ?? ''} placeholder="frontend, autenticação" onChange={e=>setMembers(members.map((item,i)=>i===index?{...item,specialties:e.target.value}:item))} /></label></>}<label>Provider<select disabled={busy || !!member.agentId || !!member.reuseAgentId} value={member.providerId} onChange={event => setMembers(members.map((item, i) => i === index ? { providerId: event.target.value, role: 'developer' } : item))}>{providers.map(provider => <option key={provider.providerId} value={provider.providerId}>{provider.name}{provider.status !== 'available' ? ' — indisponível' : ''}</option>)}</select></label><label>Papel<select disabled={busy || !!member.agentId || !!member.reuseAgentId} value={member.role} onChange={event => setMembers(members.map((item, i) => i === index ? { ...item, role: event.target.value } : item))}>{(providers.find(provider => provider.providerId === member.providerId)?.roles ?? ['developer']).map(role => <option key={role}>{role}</option>)}</select></label><small>{member.agentId ? 'Iniciado' : member.role === 'reviewer' ? 'Leitura e revisão' : member.role === 'maestro' ? 'Pode criar agentes via MCP' : member.providerId === 'opencode' ? 'Shell e testes indisponíveis; edição depende do papel' : 'Pode editar arquivos na worktree'}</small>{members.length > 1 && !member.agentId && <button disabled={busy} className="secondary-button" onClick={() => setMembers(members.filter((_, i) => i !== index))}>Remover</button>}</div>)}{members.length < 10 && <button className="secondary-button" disabled={busy} onClick={() => setMembers([...members, { providerId: 'codex', role: 'reviewer' }])}>Adicionar agente</button>}{error && <p role="alert">{error}</p>}<div className="modal-actions"><button className="start-button" disabled={busy} onClick={() => void start()}>{busy ? 'Preparando…' : 'Iniciar agentes'}</button></div></Dialog>;
}
