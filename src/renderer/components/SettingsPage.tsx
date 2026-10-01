import React from 'react';
import { defaultSettings, type AdeSettings, type ProviderAvailability } from '../../shared/settings';
import type { WorkspaceAgent } from '../../shared/contracts/ipc';
import './settings.css';

const categories = ['Geral', 'Providers', 'Permissões', 'Integrações', 'Diagnóstico'] as const;
type SettingsCategory = typeof categories[number];
export function SettingsPage({ projectId, projectName, agents, initialCategory = 'Geral', onDirtyChange }: { projectId: string; projectName: string; agents: WorkspaceAgent[]; initialCategory?: SettingsCategory; onDirtyChange: (dirty: boolean) => void }) {
  const [category, setCategory] = React.useState<SettingsCategory>(initialCategory);
  const [saved, setSaved] = React.useState<AdeSettings>(defaultSettings);
  const [draft, setDraft] = React.useState<AdeSettings>(defaultSettings);
  const [providers, setProviders] = React.useState<ProviderAvailability[]>([]);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  React.useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  React.useEffect(() => { setCategory(initialCategory); }, [initialCategory]);
  React.useEffect(() => {
    let disposed = false;
    Promise.all([window.ade.loadSettings(), window.ade.inspectProviders()]).then(([settings, detected]) => {
      if (!disposed) { setSaved(settings); setDraft(settings); setProviders(detected); }
    }).catch(error => { if (!disposed) setError(String(error)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  async function inspect() {
    setBusy(true); setError('');
    try { setProviders(await window.ade.inspectProviders()); setNotice('Verificação concluída.'); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try { const value = await window.ade.saveSettings(draft); setSaved(value); setDraft(value); setNotice('Configurações salvas.'); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  const providerOptions = <><option value="codex">Codex CLI</option><option value="opencode">OpenCode ACP</option></>;
  const permissionRows: { capability: string; developer: string; reviewer: string; maestro: string }[] = [
    { capability: 'Ler arquivos do projeto', developer: '✓', reviewer: '✓', maestro: '✓' },
    { capability: 'Editar arquivos', developer: '✓', reviewer: '—', maestro: '✓' },
    { capability: 'Executar shell', developer: 'Condicional', reviewer: '—', maestro: 'Condicional' },
    { capability: 'Executar testes', developer: 'Condicional', reviewer: '—', maestro: 'Condicional' },
    { capability: 'Criar agentes', developer: '—', reviewer: '—', maestro: '✓' },
    { capability: 'Enviar mensagens', developer: '✓', reviewer: '✓', maestro: '✓' },
    { capability: 'Atribuir responsabilidades', developer: '—', reviewer: '—', maestro: '✓' },
    { capability: 'Ler e registrar conhecimento', developer: '✓', reviewer: '✓', maestro: '✓' },
  ];
  return <section className="settings-page" aria-label="Configurações da ADE">
    <header className="settings-heading"><div><h1>Configurações</h1><p>Preferências da ADE e conexões com seus agentes.</p></div><span className="settings-project">{projectName || 'Sem projeto aberto'}</span></header>
    <div className="settings-layout"><nav aria-label="Categorias de configurações">{categories.map(item => <button key={item} aria-current={category === item ? 'page' : undefined} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</nav>
      <div className="settings-body">
        {error && <p role="alert" className="settings-error">{error}</p>}<p role="status" className="settings-notice">{notice}</p>
        {category === 'Geral' && <><h2>Preferências de execução</h2><p className="settings-intro">Defina os padrões. Provider, papel e permissões são revisados antes de iniciar cada tarefa.</p>
          <label className="setting-row"><span><strong>Provider padrão da ADE</strong><small>Usado em projetos sem preferência própria.</small></span><select disabled={busy} value={draft.defaultProvider} onChange={event => setDraft({ ...draft, defaultProvider: event.target.value as AdeSettings['defaultProvider'] })}>{providerOptions}</select></label>
          {projectId && <label className="setting-row"><span><strong>Provider deste projeto</strong><small>{draft.projectProviders[projectId] ? 'Origem: preferência do projeto' : 'Origem: padrão da ADE'}</small></span><select disabled={busy} value={draft.projectProviders[projectId] ?? ''} onChange={event => { const values = { ...draft.projectProviders }; if (event.target.value) values[projectId] = event.target.value as AdeSettings['defaultProvider']; else delete values[projectId]; setDraft({ ...draft, projectProviders: values }); }}><option value="">Herdar padrão da ADE</option>{providerOptions}</select></label>}
          <div className="setting-row"><span><strong>Organização do workspace</strong><small>Abas e dimensões dos painéis são lembradas neste dispositivo.</small></span><span>Salvo automaticamente</span></div>
        </>}
        {category === 'Providers' && <><div className="settings-section-heading"><div><h2>Providers conectados</h2><p>Verificação local, sem iniciar uma tarefa.</p></div><button className="secondary-button" onClick={() => void inspect()} disabled={busy}>{busy ? 'Verificando…' : 'Rodar diagnóstico novamente'}</button></div>{providers.map(provider => { const observed = agents.find(agent => agent.providerId === provider.providerId && agent.capabilities)?.capabilities; return <article className="provider-settings" key={provider.providerId}><header><h3>{provider.name}</h3><span className={`provider-state ${provider.status}`}>{provider.status === 'available' ? 'Disponível' : provider.status === 'unavailable' ? 'Não encontrado' : 'Verificação falhou'}</span></header><p>{provider.detail}</p><dl><dt>Executável</dt><dd>{provider.executable ?? 'Instale o CLI e adicione seu executável ao PATH.'}</dd><dt>Versão</dt><dd>{provider.version ?? 'Não verificada'}</dd><dt>Autenticação</dt><dd>Não verificada — utilize o login do próprio provider.</dd><dt>Papéis</dt><dd>{provider.roles.join(' · ')}</dd></dl>{observed && <div className="provider-capability-summary"><strong>Capacidades observadas nesta sessão</strong><span>{Object.entries(observed).filter(([, value]) => value.support === 'supported').map(([name]) => name).join(' · ') || 'Nenhuma capacidade confirmada'}</span></div>}</article>; })}<p>Alterações no PATH podem exigir reiniciar a ADE. Capacidades variam por adapter e sessão.</p></>}
        {category === 'Permissões' && <><h2>Permissões de execução</h2><p className="settings-intro">A tabela resume as ações por papel. Recursos condicionais dependem do provider selecionado e são sinalizados antes do início.</p><div className="permission-table-wrap"><table className="permission-table"><thead><tr><th>Capacidade</th><th>Developer</th><th>Reviewer</th><th>Maestro</th></tr></thead><tbody>{permissionRows.map(row => <tr key={row.capability}><th scope="row">{row.capability}</th><td className={row.developer === '—' ? 'not-granted' : ''}>{row.developer}</td><td className={row.reviewer === '—' ? 'not-granted' : ''}>{row.reviewer}</td><td className={row.maestro === '—' ? 'not-granted' : ''}>{row.maestro}</td></tr>)}</tbody></table></div><p>OpenCode não expõe execução de shell pelo adapter atual. “Tester” descreve a responsabilidade atribuída, não garante disponibilidade de comandos.</p></>}
        {category === 'Integrações' && <><h2>ADE MCP Server</h2><div className="setting-row"><span><strong>Orquestração pelo agente</strong><small>O servidor é iniciado automaticamente para um Maestro autorizado.</small></span><span>Automático · local</span></div><p>Conexões limitadas a 127.0.0.1. As permissões são verificadas por agente e projeto. Credenciais são geradas por sessão e não são armazenadas nas preferências.</p></>}
        {category === 'Diagnóstico' && <><div className="settings-section-heading"><div><h2>Diagnóstico local</h2><p>Estado observado nesta sessão. Credenciais não são incluídas.</p></div><button className="secondary-button" onClick={() => void inspect()} disabled={busy}>{busy ? 'Verificando…' : 'Rodar novamente'}</button></div><div className="diagnostic-runtime-grid"><article><span className="diagnostic-state ok">✓</span><div><strong>Interface e IPC</strong><small>Conectados ao processo local</small></div></article><article><span className={`diagnostic-state ${agents.length ? 'ok' : 'unknown'}`}>{agents.length ? '✓' : '?'}</span><div><strong>Runtime de agentes</strong><small>{agents.length ? `${agents.length} agentes reportados` : 'Nenhuma sessão observada'}</small></div></article><article><span className={`diagnostic-state ${providers.some(item => item.status === 'available') ? 'ok' : 'unknown'}`}>{providers.some(item => item.status === 'available') ? '✓' : '?'}</span><div><strong>Providers</strong><small>{providers.filter(item => item.status === 'available').length} disponíveis · autenticação não verificada</small></div></article></div><div className="diagnostic-provider-list">{providers.map(provider => <div key={provider.providerId}><span className={`diagnostic-state ${provider.status === 'available' ? 'ok' : provider.status === 'error' ? 'error' : 'unknown'}`}>{provider.status === 'available' ? '✓' : provider.status === 'error' ? '!' : '?'}</span><span><strong>{provider.name}</strong><small>{provider.version ?? provider.detail}</small></span><b>{provider.status === 'available' ? 'Instalado' : provider.status === 'unavailable' ? 'Não encontrado' : 'Erro'}</b></div>)}</div><button className="secondary-button" onClick={() => { const report = JSON.stringify({ providers: providers.map(({ executable: _path, ...provider }) => provider), settings: { defaultProvider: saved.defaultProvider }, agents: agents.map(({ agentId, providerId, role, status, capabilities }) => ({ agentId, providerId, role, status, capabilities })), generatedAt: new Date().toISOString() }, null, 2); const url = URL.createObjectURL(new Blob([report], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'ade-diagnostico.json'; link.click(); URL.revokeObjectURL(url); }}>Exportar diagnóstico sem credenciais</button></>}
        <footer className="settings-save"><span>{dirty ? 'Alterações não salvas' : busy ? 'Carregando…' : 'Configurações atualizadas'}</span><button className="secondary-button" disabled={!dirty || busy} onClick={() => { setDraft(saved); setNotice('Alterações descartadas.'); }}>Descartar</button><button className="start-button compact-start" disabled={!dirty || busy} onClick={() => void save()}>Salvar configurações</button></footer>
      </div></div>
  </section>;
}
