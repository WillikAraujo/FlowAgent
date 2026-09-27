/**
 * Isolated ADE-104 presentation fixtures.
 * Deliberately imports no shared/domain/IPC modules and is not wired into the bootstrap.
 */
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';
export type DetectionResult = 'present' | 'absent' | 'unknown';
export type SectionState = 'loading' | 'ready' | 'partial' | 'stale' | 'error' | 'empty';
export type EventOrigin = 'main' | 'renderer' | 'adapter' | 'system';
export type EventEntityType = 'project' | 'agent' | 'agentProfile' | 'task' | 'session' | 'execution' | 'note' | 'decision' | 'approval' | 'evidence';

export interface ProjectFixture {
  projectId: string;
  displayName: string;
}

export interface AgentFixture {
  entityId: string;
  adapterId: string;
  displayName: string;
  /** Adapter capability only. `unsupported` never implies detectionResult: 'absent'. */
  capabilityStates: Record<string, CapabilityState>;
}

/** Explicit presentation projection; never infer a task link from the task list. */
export type TaskLinkProjection =
  | { state: 'none' }
  | { state: 'unknown'; message?: string }
  | { state: 'linked'; taskEntityId: string };

export type AgentAttributeProjection<T> =
  | { state: 'known'; value: T }
  | { state: 'unknown' };

export interface AgentRowProjection {
  agentEntityId: string;
  detectionResult: DetectionResult;
  role: AgentAttributeProjection<string>;
  health: AgentAttributeProjection<string>;
  activity: AgentAttributeProjection<string>;
  task: TaskLinkProjection;
}

export interface TaskFixture {
  entityId: string;
  title: string;
  /** Opaque contract value; UI must display it without assigning semantics. */
  status: string;
  /** Kept opaque until Atlas confirms the persisted priority representation. */
  priority: string | number | null;
  revision: number;
  updatedAt: string;
}

export interface DomainEventFixture {
  eventId: string;
  projectId: string;
  entityId: string;
  entityType: EventEntityType;
  sequence: number;
  revision: number;
  occurredAt: string;
  origin: EventOrigin;
  type: string;
  /** Fixture payloads intentionally contain only a short, safe summary. */
  payload: { summary: string };
}

export interface SectionFixture<T> {
  state: SectionState;
  items: T[];
  updatedAt?: string;
  asOfSequence?: number;
  message?: string;
  reasons?: string[];
}

export interface OperationalListFixture {
  project: ProjectFixture;
  /** Latest adapter/session detection result, independent from the detect capability. */
  agentDetectionResult?: DetectionResult;
  agents: SectionFixture<AgentFixture>;
  agentRows?: AgentRowProjection[];
  tasks: SectionFixture<TaskFixture>;
  events: SectionFixture<DomainEventFixture>;
}

const project: ProjectFixture = {
  projectId: 'project-ade-local',
  displayName: 'ADE Core',
};

const codexAgent: AgentFixture = {
  entityId: 'agent-fixture-codex',
  adapterId: 'codex-cli',
  displayName: 'Codex',
  capabilityStates: {
    detect: 'unknown',
    sendTask: 'unknown',
    cancel: 'unknown',
  },
};

const opencodeAgent: AgentFixture = {
  entityId: 'agent-fixture-opencode',
  adapterId: 'opencode',
  displayName: 'OpenCode',
  capabilityStates: {
    detect: 'unsupported',
    sendTask: 'unknown',
    cancel: 'unknown',
  },
};

const task: TaskFixture = {
  entityId: 'task-fixture-operational-list',
  title: 'Preparar a lista operacional',
  status: 'in_progress',
  priority: 1,
  revision: 2,
  updatedAt: '2026-09-26T18:20:00.000Z',
};

const events: DomainEventFixture[] = [
  {
    eventId: '550e8400-e29b-41d4-a716-446655440001',
    projectId: project.projectId,
    entityId: codexAgent.entityId,
    entityType: 'agent',
    sequence: 14,
    revision: 1,
    occurredAt: '2026-09-26T18:18:00.000Z',
    origin: 'adapter',
    type: 'agent.detectionObserved',
    payload: { summary: 'Resultado de detecção não informado.' },
  },
  {
    eventId: '550e8400-e29b-41d4-a716-446655440002',
    projectId: project.projectId,
    entityId: task.entityId,
    entityType: 'task',
    sequence: 15,
    revision: 2,
    occurredAt: '2026-09-26T18:20:00.000Z',
    origin: 'main',
    type: 'task.statusChanged',
    payload: { summary: 'Tarefa atualizada.' },
  },
];

const knownAgentRows: AgentRowProjection[] = [
  { agentEntityId: codexAgent.entityId, detectionResult: 'unknown', role: { state: 'unknown' }, health: { state: 'unknown' }, activity: { state: 'unknown' }, task: { state: 'linked', taskEntityId: task.entityId } },
  { agentEntityId: opencodeAgent.entityId, detectionResult: 'unknown', role: { state: 'unknown' }, health: { state: 'unknown' }, activity: { state: 'unknown' }, task: { state: 'none' } },
];

export const operationalListFixtures = {
  loading: {
    project,
    agentDetectionResult: 'unknown',
    agents: { state: 'loading', items: [] },
    agentRows: [],
    tasks: { state: 'loading', items: [] },
    events: { state: 'loading', items: [] },
  },
  populated: {
    project,
    agentDetectionResult: 'unknown',
    agents: {
      state: 'ready', items: [codexAgent, opencodeAgent],
      updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15,
    },
    agentRows: knownAgentRows,
    tasks: {
      state: 'ready', items: [task],
      updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15,
    },
    events: {
      state: 'ready', items: events,
      updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15,
    },
  },
  empty: {
    project,
    agentDetectionResult: 'unknown',
    agents: { state: 'empty', items: [], message: 'A leitura atual não retornou itens de agente.' },
    agentRows: [],
    tasks: { state: 'empty', items: [], message: 'Nenhuma tarefa.' },
    events: { state: 'empty', items: [], message: 'Nenhum evento recente.' },
  },
  partial: {
    project,
    agentDetectionResult: 'unknown',
    agents: {
      state: 'partial', items: [codexAgent],
      updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15,
      message: 'Alguns detalhes não estão disponíveis.',
      reasons: ['Capabilities de envio e cancelamento são desconhecidas.'],
    },
    agentRows: [
      { agentEntityId: codexAgent.entityId, detectionResult: 'unknown', role: { state: 'unknown' }, health: { state: 'unknown' }, activity: { state: 'unknown' }, task: { state: 'unknown', message: 'Vínculo de tarefa não informado.' } },
    ],
    tasks: { state: 'ready', items: [task], updatedAt: task.updatedAt, asOfSequence: 15 },
    events: { state: 'ready', items: events, updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15 },
  },
  stale: {
    project,
    agentDetectionResult: 'unknown',
    agents: {
      state: 'stale', items: [codexAgent],
      updatedAt: '2026-09-26T18:10:00.000Z', asOfSequence: 14,
      message: 'Mostrando o último snapshot identificado enquanto atualizamos.',
    },
    agentRows: [
      { agentEntityId: codexAgent.entityId, detectionResult: 'unknown', role: { state: 'unknown' }, health: { state: 'unknown' }, activity: { state: 'unknown' }, task: { state: 'unknown', message: 'Vínculo de tarefa não informado.' } },
    ],
    tasks: {
      state: 'stale', items: [task],
      updatedAt: task.updatedAt, asOfSequence: 15,
      message: 'Mostrando o último snapshot identificado enquanto atualizamos.',
    },
    events: {
      state: 'stale', items: events,
      updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15,
      message: 'Mostrando o último snapshot identificado enquanto atualizamos.',
    },
  },
  error: {
    project,
    agentDetectionResult: 'unknown',
    agents: { state: 'error', items: [], message: 'Não foi possível carregar agentes.' },
    agentRows: [],
    tasks: { state: 'error', items: [], message: 'Não foi possível carregar tarefas.' },
    events: { state: 'error', items: [], message: 'Não foi possível carregar eventos.' },
  },
  tasksEmpty: {
    project,
    agentDetectionResult: 'unknown',
    agents: { state: 'ready', items: [codexAgent], updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15 },
    agentRows: [
      { agentEntityId: codexAgent.entityId, detectionResult: 'unknown', role: { state: 'unknown' }, health: { state: 'unknown' }, activity: { state: 'unknown' }, task: { state: 'none' } },
    ],
    tasks: { state: 'empty', items: [], message: 'Nenhuma tarefa.' },
    events: { state: 'ready', items: events, updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15 },
  },
  eventsEmpty: {
    project,
    agentDetectionResult: 'unknown',
    agents: { state: 'ready', items: [codexAgent], updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15 },
    agentRows: [
      { agentEntityId: codexAgent.entityId, detectionResult: 'unknown', role: { state: 'unknown' }, health: { state: 'unknown' }, activity: { state: 'unknown' }, task: { state: 'unknown', message: 'Vínculo de tarefa não informado.' } },
    ],
    tasks: { state: 'ready', items: [task], updatedAt: task.updatedAt, asOfSequence: 15 },
    events: { state: 'empty', items: [], message: 'Nenhum evento recente.' },
  },
  agentsEmptyTasksEventsPresent: {
    project,
    agentDetectionResult: 'absent',
    agents: {
      state: 'empty', items: [],
      message: 'A detecção foi concluída e nenhuma sessão CLI local autenticada e disponível foi encontrada.',
      reasons: ['Varredura concluída sem sessão qualificável.'],
    },
    agentRows: [],
    tasks: { state: 'ready', items: [task], updatedAt: task.updatedAt, asOfSequence: 15 },
    events: { state: 'ready', items: events, updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15 },
  },
  agentDetectionUnknown: {
    project,
    agentDetectionResult: 'unknown',
    agents: {
      state: 'partial', items: [],
      message: 'A detecção de agentes ainda não foi confirmada.',
      reasons: ['A checagem não foi executada, não é suportada, falhou ou foi inconclusiva.'],
    },
    agentRows: [],
    tasks: { state: 'ready', items: [task], updatedAt: task.updatedAt, asOfSequence: 15 },
    events: { state: 'ready', items: events, updatedAt: '2026-09-26T18:20:00.000Z', asOfSequence: 15 },
  },
} satisfies Record<string, OperationalListFixture>;
