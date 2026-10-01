import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../../src/main/runtime/agent-runtime.ts';
import { ProviderRegistry } from '../../src/main/runtime/provider-registry.ts';
import { CommunicationBroker } from '../../src/main/runtime/communication-broker.ts';
import { AgentAccessPolicy } from '../../src/main/runtime/agent-access-policy.ts';
import { providerHarness } from '../fixtures/runtime-provider.mjs';

function setup(initialStatus = 'ready') {
  const harness = providerHarness('fixture', initialStatus);
  const registry = new ProviderRegistry(); registry.register(harness.provider);
  const runtime = new AgentRuntime(registry);
  const create = (role = 'reviewer', worktreeId = 'feature/a') => runtime.createAgent({projectId:'project',worktreeId,workingDirectory:process.cwd(),providerId:'fixture',role,taskId:'task'});
  return { ...harness, runtime, create };
}
for (const status of ['created','ready']) test(`prepared ${status} session starts exactly once`, async () => {
  const {runtime,create,calls} = setup(status); const agent = create(); const session = await runtime.createSession(agent.agentId);
  await runtime.startSession(agent.agentId,session.sessionId,'Task');
  await assert.rejects(runtime.startSession(agent.agentId,session.sessionId,'Task'), /already been started/);
  assert.equal(calls.filter(call=>call[0]==='start').length,1);
});
test('turn completion is waiting; output silence never completes the agent', async () => {
  const {runtime,create,emit,output} = setup(); const agent = create(); const session = await runtime.createSession(agent.agentId);
  await runtime.startSession(agent.agentId,session.sessionId,'Task'); output(session.sessionId,'Result');
  assert.equal(runtime.getAgent(agent.agentId).status,'running');
  emit(session.sessionId,'agent.turn.completed');
  assert.equal(runtime.getAgent(agent.agentId).status,'waiting');
  assert.equal(runtime.listEvents(agent.agentId).find(event=>event.type==='agent.response').data.message,'Result');
});
test('startup failure cleans up the provider', async () => {
  const {runtime,create,provider,calls} = setup(); const agent = create(); const session = await runtime.createSession(agent.agentId);
  provider.start = async()=>{throw new Error('handshake failed');};
  await assert.rejects(runtime.startSession(agent.agentId,session.sessionId,'Task'), /handshake failed/);
  assert.ok(calls.some(call=>call[0]==='stop'));
  assert.equal(runtime.getAgent(agent.agentId).status,'failed');
});
test('worktree permits multiple readers and only one developer', () => {
  const {create,runtime} = setup(); const developer = create('developer'); create(); create();
  assert.throws(()=>create('developer'), /owns this worktree/);
  runtime.markSetupFailed(developer.agentId); assert.doesNotThrow(()=>create('developer'));
});
test('project subscriptions are scoped and unsubscribe', () => {
  const {runtime,create} = setup(); const received=[]; const stop=runtime.subscribeProject('project',event=>received.push(event));
  const other=[];runtime.subscribeProject('other',event=>other.push(event));create();stop();create();
  assert.equal(received.length,1);assert.equal(other.length,0);
});
test('new provider session preserves logical identity', async () => {
  const {runtime,create} = setup(); const agent=create(); const first=await runtime.createSession(agent.agentId);
  await runtime.stopAgent(agent.agentId); const second=await runtime.createSession(agent.agentId);
  assert.notEqual(first.sessionId,second.sessionId); assert.equal(second.agentId,agent.agentId);
});
test('broker is provider agnostic and denies cross-project messages', async () => {
  const {runtime,create,calls} = setup(); const a=create(); const b=create(); await runtime.createSession(a.agentId);await runtime.createSession(b.agentId);
  const broker=new CommunicationBroker(runtime,new AgentAccessPolicy());
  const principal={id:a.agentId,kind:'agent',projectId:'project',role:'reviewer',grants:['agent.communicate']};
  await broker.sendMessage({principal,from:a.agentId,to:b.agentId,message:'Review'});
  assert.ok(calls.some(call=>call[0]==='send'&&call[2]==='Review'));
  await assert.rejects(broker.sendMessage({principal:{...principal,projectId:'other'},from:a.agentId,to:b.agentId,message:'Review'}), /limited/);
});
test('developer cannot acquire agent creation permission by supplying a grant', () => {
  const policy=new AgentAccessPolicy();assert.throws(()=>policy.authorize({id:'a',kind:'agent',projectId:'p',role:'developer',grants:['agent.create']},'agent.create'), /Maestro/);
});
test('session setup capability failure stops the created provider session', async()=>{
  const {runtime,create,provider,calls}=setup();const agent=create();provider.getCapabilities=async()=>{throw new Error('capability negotiation failed');};
  await assert.rejects(runtime.createSession(agent.agentId),/capability negotiation/);
  assert.ok(calls.some(call=>call[0]==='stop'));assert.equal(runtime.getAgent(agent.agentId).status,'failed');
});
test('broker cancellation rejects immediately and removes output listener',async()=>{
  const {runtime,create,provider}=setup();const agent=create();await runtime.createSession(agent.agentId);
  const broker=new CommunicationBroker(runtime,new AgentAccessPolicy());const controller=new AbortController();controller.abort();
  await assert.rejects(broker.waitForResponse(agent.agentId,{signal:controller.signal}),/cancelled/);
});
