export function providerHarness(id = 'fixture', initialStatus = 'ready') {
  const sessions = new Map();
  const events = new Map();
  const outputs = new Map();
  const calls = [];
  let count = 0;
  const capabilities = Object.fromEntries(['terminal','streaming','mcpClient','mcpServer','fileEditing','toolCalling','sessionResume','structuredOutput','structuredEvents','sendMessage','interrupt','stop','subagents'].map(key => [key, { support: ['streaming','structuredEvents','sendMessage','interrupt','stop'].includes(key) ? 'supported' : 'unsupported' }]));
  const provider = {
    providerId: id,
    getCapabilities: async () => capabilities,
    create: async input => { calls.push(['create', input]); const session = { sessionId: `${id}-${++count}`, providerId: id, status: initialStatus, createdAt: new Date().toISOString() }; sessions.set(session.sessionId, session); return {...session}; },
    start: async (id, input) => { calls.push(['start', id, input]); const session = sessions.get(id); session.status = 'running'; session.startedAt = new Date().toISOString(); emit(id, 'agent.started'); return {...session}; },
    send: async (id, text) => { calls.push(['send', id, text]); },
    interrupt: async id => { emit(id, 'agent.waiting'); },
    stop: async id => { calls.push(['stop', id]); if (sessions.has(id)) emit(id, 'agent.stopped'); },
    resume: async () => { throw new Error('unsupported'); },
    getStatus: async id => sessions.has(id) ? {...sessions.get(id)} : undefined,
    subscribeEvents: (id, handler) => { events.set(id, handler); return () => events.delete(id); },
    subscribeOutput: (id, handler) => { outputs.set(id, handler); return () => outputs.delete(id); },
    shutdown: async () => {},
  };
  function emit(id, type, data = {}) {
    const status = {'agent.started':'running','agent.waiting':'waiting','agent.turn.completed':'waiting','agent.completed':'completed','agent.stopped':'stopped','agent.failed':'failed'}[type];
    if (status) sessions.get(id).status = status;
    events.get(id)?.({sessionId:id,sequence:1,type,occurredAt:new Date().toISOString(),data});
  }
  function output(id, text) { outputs.get(id)?.({sessionId:id,sequence:1,text,receivedAt:new Date().toISOString()}); }
  return {provider, sessions, calls, emit, output, capabilities};
}
