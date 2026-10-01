import React from 'react';
import type { FlowAgentEvent, FlowAgentProfile, FlowAgentProject, FlowAgentRunReference, FlowAgentRunSnapshot } from '../../shared/contracts/ipc';
import './flow-agent.css';

type Api = Window['ade']['flowAgent'];
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const labels: Record<FlowAgentRunSnapshot['state'], string> = {
  queued: 'Preparando', running: 'Executando', cancel_requested: 'Cancelando',
  succeeded: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada',
};

function getApi(): Api | null {
  const api = window.ade?.flowAgent;
  return api && ['openProject', 'start', 'getRun', 'subscribe', 'unsubscribe', 'cancel']
    .every((method) => typeof api[method as keyof Api] === 'function') ? api : null;
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Não foi possível concluir a operação.';
}

export function FlowAgentView() {
  const [api] = React.useState(getApi);
  const [project, setProject] = React.useState<FlowAgentProject | null>(null);
  const [task, setTask] = React.useState('');
  const [profile, setProfile] = React.useState<FlowAgentProfile>('reviewer');
  const [run, setRun] = React.useState<FlowAgentRunSnapshot | null>(null);
  const [output, setOutput] = React.useState('');
  const [progress, setProgress] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const current = React.useRef<FlowAgentRunReference | null>(null);
  const lastSeq = React.useRef(0);
  const outputElement = React.useRef<HTMLPreElement | null>(null);
  const active = busy || Boolean(run && !terminal.has(run.state));

  React.useEffect(() => () => {
    if (api && current.current) void api.unsubscribe(current.current).catch(() => undefined);
  }, [api]);
  React.useEffect(() => {
    if (outputElement.current) outputElement.current.scrollTop = outputElement.current.scrollHeight;
  }, [output]);

  async function chooseProject() {
    if (!api || active) return;
    setBusy(true); setError(null);
    try {
      const result = await api.openProject();
      if (result.outcome === 'opened') {
        if (current.current) await api.unsubscribe(current.current);
        current.current = null; lastSeq.current = 0;
        setProject(result.project); setRun(null); setOutput(''); setProgress('');
      } else if (result.outcome === 'invalid') {
        setError(result.reason === 'not-git' ? 'Escolha a pasta raiz de um repositório Git.' : 'Não foi possível abrir essa pasta com segurança.');
      }
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  function onEvent(event: FlowAgentEvent) {
    const ref = current.current;
    if (!ref || event.projectId !== ref.projectId || event.runId !== ref.runId || event.seq <= lastSeq.current) return;
    lastSeq.current = event.seq;
    if (event.type === 'run.output') setOutput((text) => (text + event.payload.text).slice(-100_000));
    if (event.type === 'run.progress') setProgress(event.payload.message);
    if (event.type === 'run.started') setRun((value) => value && { ...value, state: 'running' });
    if (event.type === 'run.cancel_requested') setRun((value) => value && { ...value, state: 'cancel_requested' });
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      setRun((value) => value && { ...value, state: event.payload.status, result: event.payload });
    }
    if (event.type === 'run.protocol_error') setError('A saída do Codex não pôde ser lida completamente.');
  }

  async function startRun() {
    if (!api || !project || !task.trim() || active) return;
    setBusy(true); setError(null); setOutput(''); setProgress('');
    try {
      if (current.current) await api.unsubscribe(current.current);
      current.current = null;
      setRun(null);
      const started = await api.start({ requestId: crypto.randomUUID(), projectId: project.projectId, task: task.trim(), profile });
      const ref = { projectId: project.projectId, runId: started.runId };
      current.current = ref; lastSeq.current = 0;
      setRun({ ...ref, profile, state: started.state });
      const subscribed = await api.subscribe(ref, onEvent);
      if (subscribed.outcome !== 'subscribed') throw new Error('A tarefa iniciou, mas o acompanhamento não está disponível.');
      const snapshot = await api.getRun(ref);
      setRun((previous) => previous && terminal.has(previous.state) && !terminal.has(snapshot.state) ? previous : snapshot);
    } catch (cause) {
      setError(message(cause));
      if (current.current) try { setRun(await api.getRun(current.current)); } catch { /* retain last state */ }
    } finally { setBusy(false); }
  }

  async function cancelRun() {
    if (!api || !current.current || !run || terminal.has(run.state)) return;
    setError(null);
    try {
      const result = await api.cancel(current.current);
      if (result.outcome === 'cancel-requested') setRun((value) => value && { ...value, state: 'cancel_requested' });
      if (result.outcome === 'already-terminal') setRun(await api.getRun(current.current));
    } catch (cause) { setError(message(cause)); }
  }

  return <main className="flow-shell">
    <header className="flow-topbar"><div className="flow-brand"><span className="flow-monogram">A</span>ADE <strong>FlowAgent</strong></div><span className={`flow-connection ${api ? 'connected' : ''}`}>{api ? 'Processo local conectado' : 'Integração pendente'}</span></header>
    <div className="flow-content">
      <div className="flow-heading"><div><p className="flow-eyebrow">EXECUÇÃO LOCAL</p><h1>Uma tarefa por vez.</h1><p>Escolha um projeto, descreva o trabalho e acompanhe o Codex aqui.</p></div><span className="flow-model">Codex · Luna · Medium</span></div>
      {!api && <div className="flow-notice" role="status">A ponte de execução ainda não está disponível nesta versão. O painel será habilitado após a revisão da integração do preload.</div>}
      <section className="flow-card" aria-labelledby="project-title">
        <div className="flow-card-heading"><span className="flow-step">01</span><div><h2 id="project-title">Projeto</h2><p>A execução usa a pasta raiz de um repositório Git local.</p></div></div>
        <div className="flow-project-row"><div><span className="flow-field-label">REPOSITÓRIO</span><strong>{project?.displayName ?? 'Nenhum projeto selecionado'}</strong></div><button className="flow-button secondary" type="button" onClick={chooseProject} disabled={!api || active}>Escolher projeto</button></div>
      </section>
      <section className="flow-card" aria-labelledby="task-title">
        <div className="flow-card-heading"><span className="flow-step">02</span><div><h2 id="task-title">Tarefa</h2><p>Envie uma instrução objetiva para o agente.</p></div></div>
        <label className="flow-field-label" htmlFor="flow-task">INSTRUÇÃO</label>
        <textarea id="flow-task" value={task} maxLength={700} onChange={(event) => setTask(event.target.value)} disabled={active} placeholder="Ex.: Revise este projeto e indique o próximo ajuste mais importante." />
        <div className="flow-task-meta"><span>{task.length}/700</span><span>A saída pode conter conteúdo do projeto.</span></div>
        <fieldset className="flow-profiles" disabled={active}><legend className="flow-field-label">PERFIL</legend>
          <label className={profile === 'reviewer' ? 'flow-profile selected' : 'flow-profile'}><input type="radio" name="profile" checked={profile === 'reviewer'} onChange={() => setProfile('reviewer')} /><span><strong>Revisor</strong><small>Leitura do projeto</small></span></label>
          <label className={profile === 'developer' ? 'flow-profile selected' : 'flow-profile'}><input type="radio" name="profile" checked={profile === 'developer'} onChange={() => setProfile('developer')} /><span><strong>Desenvolvedor</strong><small>Pode alterar arquivos do projeto</small></span></label>
        </fieldset>
        <div className="flow-actions"><button className="flow-button primary" type="button" onClick={startRun} disabled={!api || !project || !task.trim() || active}>Iniciar tarefa</button>{run && !terminal.has(run.state) && <button className="flow-button secondary" type="button" onClick={cancelRun} disabled={run.state === 'cancel_requested'}>Cancelar</button>}</div>
      </section>
      <section className="flow-card" aria-labelledby="result-title">
        <div className="flow-card-heading"><span className="flow-step">03</span><div><h2 id="result-title">Acompanhamento</h2><p>Estado e resposta da execução atual.</p></div><span className={`flow-run-state state-${run?.state ?? 'idle'}`} role="status">{run ? labels[run.state] : 'Aguardando tarefa'}</span></div>
        {error && <div className="flow-error" role="alert">{error}</div>}
        {progress && <p className="flow-progress">{progress}</p>}
        <pre ref={outputElement} className="flow-output" aria-label="Saída do Codex" aria-live="polite">{output || 'A resposta do agente aparecerá aqui.'}</pre>
      </section>
    </div>
  </main>;
}
