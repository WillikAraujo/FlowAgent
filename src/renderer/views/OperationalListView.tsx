import { AgentDirectory } from '../components/AgentDirectory';
import { OperationalSection } from '../components/OperationalSection';
import { SectionListContent } from '../components/SectionListContent';
import type { OperationalListFixture, SectionState } from '../mocks/operationalList.fixtures';
import './operational-list.css';

type OperationalListViewProps = {
  fixture: OperationalListFixture;
  presentation: 'preview' | 'demonstration';
};

export function OperationalListView({ fixture: viewData, presentation }: OperationalListViewProps) {
  const isDemonstration = presentation === 'demonstration';
  return (
    <main className="ade-workspace">
      <aside className="workspace-rail" aria-label="Navegação principal">
        <div className="ade-monogram" aria-label="ADE">A</div>
        <div className="rail-divider" />
        <span className="rail-item rail-item-active" aria-label="Operação atual"><span className="rail-glyph rail-glyph-grid" /></span>
        <span className="rail-item" aria-hidden="true"><span className="rail-glyph rail-glyph-branch" /></span>
        <span className="rail-item" aria-hidden="true"><span className="rail-glyph rail-glyph-clock" /></span>
        <div className="rail-spacer" />
        <span className="rail-avatar" aria-label="Usuário local">V</span>
      </aside>

      <div className="workspace-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>Operação</strong></div>
          <div className="preview-status"><span className="status-dot" />{isDemonstration ? 'Demonstração local' : 'Prévia local'} <span className="preview-separator">·</span> dados desconectados</div>
        </header>

        <div className="page-content">
          <section className="page-intro">
            <div>
              <p className="eyebrow">VISÃO GERAL</p>
              <h1>Operação</h1>
              <p className="intro-copy">Agentes, tarefas e atividade recente do projeto.</p>
            </div>
            <div className="project-context">
              <span className="project-context-label">PROJETO</span>
              <span className="project-context-value">{viewData.project.displayName}</span>
            </div>
          </section>

          {isDemonstration && <aside className="simulation-callout" role="note">
            Demonstração: agente, tarefas e eventos são dados sintéticos locais; não representam estado real nem confirmam sessão CLI.
          </aside>}

          <nav className="section-tabs" aria-label="Seções da operação">
            <span className="section-tab section-tab-active">Visão geral</span>
            <span className="section-tab">Agentes <span className="tab-unknown">?</span></span>
            <span className="section-tab">Tarefas</span>
            <span className="section-tab">Atividade</span>
          </nav>

          <div className="overview-grid">
            <OperationalSection title={isDemonstration ? 'Agentes · Demonstração' : 'Agentes'} description={isDemonstration ? 'Registro sintético; detecção desconhecida' : 'Disponibilidade e estado operacional'} marker={sectionMarker(viewData.agents.state)} className="agents-section">
              <AgentDirectory
                agents={viewData.agents}
                detectionResult={viewData.agentDetectionResult ?? 'unknown'}
                rows={viewData.agentRows ?? []}
                tasks={viewData.tasks.items}
              />
            </OperationalSection>

            <OperationalSection title={isDemonstration ? 'Tarefas · Demonstração' : 'Tarefas'} description={isDemonstration ? 'Dados simulados locais' : 'Objetivos do projeto'} marker={sectionMarker(viewData.tasks.state)} className="tasks-section">
              <SectionListContent section={viewData.tasks} itemLabel="tarefas" itemKey={(task) => task.entityId} renderItem={(task) => (
                <article className="task-item">
                  <div className="list-item-heading"><h3>{task.title}</h3><span className="opaque-status">{task.status}</span></div>
                  <p>Prioridade {task.priority === null ? 'não informada' : String(task.priority)}</p>
                  <ItemTimestamp timestamp={task.updatedAt} />
                </article>
              )} />
            </OperationalSection>

            <OperationalSection title={isDemonstration ? 'Eventos recentes · Demonstração' : 'Atividade recente'} description={isDemonstration ? 'Eventos simulados locais' : 'Eventos de domínio do projeto'} marker={sectionMarker(viewData.events.state)} className="events-section">
              <SectionListContent section={viewData.events} itemLabel="eventos" itemKey={(event) => event.eventId} renderItem={(event) => (
                <article className="event-item">
                  <span className="event-sequence">{event.sequence}</span>
                  <div className="event-content">
                    <div className="list-item-heading"><h3>{event.payload.summary}</h3><time dateTime={event.occurredAt}><ItemTimestamp timestamp={event.occurredAt} /></time></div>
                    <p>{event.type}</p>
                  </div>
                </article>
              )} />
            </OperationalSection>
          </div>

          <footer className="workspace-footer">
            <span>{isDemonstration ? 'Agente, tarefas e eventos acima são dados sintéticos, sem leitura do projeto.' : 'Os dados aparecem aqui quando uma leitura do projeto estiver disponível.'}</span>
            <span className="footer-build">{isDemonstration ? 'ADE · demonstração' : 'ADE · prévia isolada'}</span>
          </footer>
        </div>
      </div>
    </main>
  );
}

function sectionMarker(state: SectionState) {
  const labels: Record<SectionState, string> = {
    loading: 'CARREGANDO',
    ready: 'ATUALIZADO',
    partial: 'PARCIAL',
    stale: 'DESATUALIZADO',
    error: 'ERRO NA LEITURA',
    empty: 'SEM ITENS',
  };
  return labels[state];
}

function ItemTimestamp({ timestamp }: { timestamp: string }) {
  return <span className="item-timestamp">{new Date(timestamp).toLocaleString('pt-BR')}</span>;
}
