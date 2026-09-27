import type { OperationalListFixture } from './operationalList.fixtures';
import { operationalListFixtures } from './operationalList.fixtures';

/** Initial renderer preview: no project snapshot or live domain data is asserted. */
export const operationalPreviewFixture: OperationalListFixture = {
  project: { projectId: 'preview-only', displayName: 'Projeto sem identificação' },
  agentDetectionResult: 'unknown',
  agents: {
    state: 'partial',
    items: [],
    message: 'A detecção de agentes ainda não foi confirmada.',
    reasons: ['A prévia isolada não executa detecção nem verifica sessões CLI.'],
  },
  agentRows: [],
  tasks: { state: 'loading', items: [], message: 'Nenhum snapshot de tarefas recebido nesta prévia.' },
  events: { state: 'loading', items: [], message: 'Nenhum snapshot de eventos recebido nesta prévia.' },
};

/** Local demonstration only: agents remain unknown and tasks/events are simulated. */
export const operationalShellDemoFixture: OperationalListFixture = {
  ...operationalPreviewFixture,
  project: { projectId: 'demo-only', displayName: 'Demonstração local' },
  agents: {
    state: 'ready',
    items: [{
      entityId: 'demo-agent-only',
      adapterId: 'fixture-demo',
      displayName: 'Agente de demonstração',
      capabilityStates: { detect: 'unknown', sendTask: 'unknown', cancel: 'unknown' },
    }],
    message: 'Linha sintética para demonstração; não representa uma sessão CLI verificada.',
  },
  agentDetectionResult: 'unknown',
  agentRows: [{
    agentEntityId: 'demo-agent-only',
    detectionResult: 'unknown',
    role: { state: 'known', value: 'Papel de demonstração' },
    health: { state: 'unknown' },
    activity: { state: 'unknown' },
    task: { state: 'linked', taskEntityId: operationalListFixtures.populated.tasks.items[0].entityId },
  }],
  tasks: operationalListFixtures.populated.tasks,
  events: operationalListFixtures.populated.events,
};
